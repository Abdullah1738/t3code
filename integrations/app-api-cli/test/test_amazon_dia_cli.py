"""Offline synthetic CLI/transport boundary checks. Never starts the Dia bridge."""
from contextlib import redirect_stdout
import io
import errno
import json
import os
from pathlib import Path
import socket
import signal
import subprocess
import sys
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import amazon_dia_cli as cli
from test_amazon_browser_orders import OID, OTHER, dia, snapshot


def payload(value=None):
    return json.dumps({'binding': {'tab_id': 'fixture-tab', 'target_id': 'fixture-target'},
                       'response': value or dia()}).encode()


class CliTests(unittest.TestCase):
    def setUp(self):
        self.block_network = patch.object(socket.socket, 'connect', side_effect=AssertionError('network forbidden'))
        self.block_network.start()
        self.addCleanup(self.block_network.stop)

    def read(self, data=None, **kwargs):
        with patch.object(cli, '_bounded_process', return_value=data if data is not None else payload()) as call, \
                patch.object(cli.shutil, 'which', return_value='/synthetic/node'):
            result = cli.read_orders(**kwargs)
        return result, call

    def test_real_shape_private_envelope_yields_only_parser_output(self):
        response = dia()
        response['target']['targetId'] = response['target'].pop('id')
        response['target']['webSocketDebuggerUrl'] = 'synthetic-secret-ws'
        response['target']['title'] = 'synthetic-private-title'
        result, _ = self.read(payload(response))
        self.assertEqual(result['transport'], 'dia_mcp_stdio')
        self.assertEqual(result['orders'][0]['order_id'], OID)
        self.assertFalse(result['orders'][0]['terminal'])
        for text in ['synthetic-secret-ws', 'synthetic-private-title', 'target_id', 'binding']:
            self.assertNotIn(text, json.dumps(result))

    def test_explicit_tab_timeout_and_default_discovery(self):
        _, call = self.read(tab_id='fixture-tab', timeout=12)
        args = call.call_args.args[0]
        self.assertEqual(args[-4:], ['--timeout-ms', '11000', '--tab-id', 'fixture-tab'])
        self.assertEqual(call.call_args.kwargs['timeout'], 12)
        _, call = self.read()
        self.assertNotIn('--tab-id', call.call_args.args[0])

    def test_track_filters_exact_id_and_missing_is_explicit(self):
        result, _ = self.read(expected_order_id=OID)
        self.assertEqual(len(result['orders']), 1)
        with self.assertRaisesRegex(cli.BrowserOrdersError, '^ORDER_NOT_ON_THIS_PAGE$'):
            self.read(expected_order_id=OTHER)

    def test_invalid_arguments_never_spawn(self):
        for values in [{'timeout': float('nan')}, {'timeout': float('inf')}, {'timeout': 0},
                       {'timeout': True}, {'timeout': 61}, {'tab_id': 'bad\ninput'},
                       {'tab_id': ''}, {'expected_order_id': OID + '0'}]:
            with self.subTest(values=values), patch.object(cli.subprocess, 'Popen', side_effect=AssertionError('spawn')):
                with self.assertRaises(cli.BrowserOrdersError):
                    cli.read_orders(**values)

    def test_missing_node_fails_before_transport(self):
        with patch.object(cli.shutil, 'which', return_value=None), \
                patch.object(cli, '_bounded_process', side_effect=AssertionError('transport')):
            with self.assertRaisesRegex(cli.BrowserOrdersError, '^DIA_BRIDGE_UNAVAILABLE$'):
                cli.read_orders()

    def test_binding_not_accepted_from_wrong_explicit_tab(self):
        with self.assertRaisesRegex(cli.BrowserOrdersError, '^DIA_BINDING_MISMATCH$'):
            self.read(tab_id='other-tab')
        value = json.loads(payload())
        value['binding']['target_id'] = 'other-target'
        with self.assertRaisesRegex(cli.BrowserOrdersError, '^DIA_BINDING_MISMATCH$'):
            self.read(json.dumps(value).encode())

    def test_malformed_response_safe(self):
        for value in [b'bad-secret', b'null', b'[]', b'{}', b'\xff', b'{"binding":"secret"}']:
            with self.assertRaises(cli.BrowserOrdersError) as caught:
                self.read(value)
            self.assertNotIn('secret', str(caught.exception))

    def test_transport_errors_allowlist(self):
        for error in ['DIA_TIMEOUT', 'DIA_RESPONSE_TOO_LARGE', 'AMAZON_ORDERS_TAB_AMBIGUOUS']:
            with self.assertRaisesRegex(cli.BrowserOrdersError, '^' + error + '$'):
                self.read(json.dumps({'error': error}).encode())
        with self.assertRaisesRegex(cli.BrowserOrdersError, '^DIA_TRANSPORT_FAILED$'):
            self.read(b'{"error":"raw-private-error"}')

    def invoke(self, argv, *, result=None, error=None):
        output = io.StringIO()
        with patch.object(cli, 'read_orders', return_value=result, side_effect=error) as call, redirect_stdout(output):
            code = cli.main(argv)
        return code, json.loads(output.getvalue()), call

    def test_commands_are_separate_and_json(self):
        for argv in [['orders'], ['orders', '--json'], ['track', OID, '--json']]:
            code, result, call = self.invoke(argv, result={'source': cli.SOURCE, 'orders': []})
            self.assertEqual(code, 0)
            self.assertEqual(result['source'], cli.SOURCE)
            self.assertEqual(call.call_args.kwargs['expected_order_id'], OID if argv[0] == 'track' else None)

    def test_missing_extra_and_unknown_arguments_no_echo(self):
        for argv in [['track'], ['orders', OID], ['secret-command'], ['orders', '--secret', 'raw-secret'],
                     ['orders', '--timeout', 'raw-secret']]:
            code, result, call = self.invoke(argv)
            self.assertEqual(code, 1)
            self.assertEqual(result['error'], 'INVALID_ARGUMENTS')
            call.assert_not_called()
            self.assertNotIn('secret', json.dumps(result))

    def test_raw_exception_never_logged(self):
        code, result, _ = self.invoke(['orders'], error=RuntimeError('raw-private-error'))
        self.assertEqual((code, result['error']), (1, 'DIA_TRANSPORT_FAILED'))

    def test_challenge_and_missing_order_nonzero_not_terminal(self):
        for error in ['AUTH_OR_CHALLENGE_REQUIRED', 'ORDER_NOT_ON_THIS_PAGE']:
            code, result, _ = self.invoke(['track', OID], error=cli.BrowserOrdersError(error))
            self.assertEqual(code, 1)
            self.assertEqual(result['error'], error)
            self.assertFalse(result['whole_order_delivered'])
            self.assertFalse(result['tracker_integration_enabled'])

    def test_bounded_process_success_strips_debug_environment(self):
        script = 'import os; print(os.environ.get("NODE_OPTIONS", "clean")); print(os.environ.get("PRIVATE_FIXTURE", "clean"))'
        with patch.dict(os.environ, {'NODE_OPTIONS': '--inspect', 'PRIVATE_FIXTURE': 'secret'}):
            result = cli._bounded_process([sys.executable, '-c', script], timeout=2)
        self.assertEqual(result, b'clean\nclean\n')

    def test_bounded_process_oversize_and_stderr_not_retained(self):
        with self.assertRaisesRegex(cli.BrowserOrdersError, '^DIA_RESPONSE_TOO_LARGE$'):
            cli._bounded_process([sys.executable, '-c', 'print("x"*10000)'], timeout=2, max_bytes=100)
        with self.assertRaisesRegex(cli.BrowserOrdersError, '^DIA_TRANSPORT_FAILED$'):
            cli._bounded_process([sys.executable, '-c', 'import sys; print("private",file=sys.stderr); sys.exit(2)'], timeout=2)

    def test_exited_zombie_eperm_preserves_oversize_after_verified_cleanup(self):
        real_stop, real_killpg = cli._stop_group, os.killpg
        injections = []

        def stop_after_exit(process):
            # Deterministic version of the observed macOS exited-leader race.
            process.wait(timeout=2)

            def signal_group(pgid, sig):
                if sig == signal.SIGTERM and not injections:
                    injections.append(pgid)
                    raise PermissionError(errno.EPERM, 'synthetic-private-error')
                return real_killpg(pgid, sig)

            with patch.object(cli.os, 'killpg', side_effect=signal_group):
                real_stop(process)

        with patch.object(cli, '_stop_group', side_effect=stop_after_exit):
            with self.assertRaisesRegex(cli.BrowserOrdersError, '^DIA_RESPONSE_TOO_LARGE$'):
                cli._bounded_process([sys.executable, '-c', 'print("x"*10000)'], timeout=2, max_bytes=100)
        self.assertEqual(len(injections), 1)

    def test_exited_leader_does_not_skip_live_grandchild(self):
        process = Mock(pid=987654321, returncode=0)
        # TERM sees the exiting-leader race; the group then has a live child.
        def signal_group(pgid, sig):
            self.assertEqual(pgid, process.pid)
            if sig == signal.SIGTERM:
                raise PermissionError(errno.EPERM, 'synthetic-private-error')
            if sig == signal.SIGKILL:
                signal_group.killed = True
            elif sig == 0 and signal_group.killed:
                raise ProcessLookupError(errno.ESRCH, 'group gone')
        signal_group.killed = False
        with patch.object(cli.os, 'killpg', side_effect=signal_group), \
                patch.object(cli.time, 'monotonic', side_effect=[0, 0.1, 0.2, 0.3]), \
                patch.object(cli.time, 'sleep'):
            cli._stop_group(process)
        self.assertTrue(signal_group.killed)
        process.poll.assert_called()

    def test_cleanup_permission_denied_or_surviving_group_fails_closed(self):
        for denied in (True, False):
            process = Mock(pid=987654321, returncode=0)
            def signal_group(pgid, sig):
                if denied:
                    raise PermissionError(errno.EPERM, 'synthetic-private-error')
            with self.subTest(denied=denied), \
                    patch.object(cli.os, 'killpg', side_effect=signal_group) as call, \
                    patch.object(cli.time, 'monotonic', side_effect=range(100)), \
                    patch.object(cli.time, 'sleep'):
                with self.assertRaisesRegex(cli.BrowserOrdersError, '^DIA_CLEANUP_FAILED$'):
                    cli._stop_group(process)
            self.assertIn((process.pid, signal.SIGKILL), [c.args for c in call.call_args_list])

    def test_reaped_leader_with_real_term_ignoring_grandchild_is_cleaned(self):
        child = 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print("ready",flush=True); time.sleep(60)'
        script = ('import os,subprocess,sys; '
                  f'p=subprocess.Popen([sys.executable,"-c",{child!r}],stdout=subprocess.PIPE); '
                  'p.stdout.readline(); print(p.pid,flush=True); os._exit(0)')
        process = subprocess.Popen([sys.executable, '-c', script], stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, start_new_session=True, text=True)
        try:
            grandchild = int(process.stdout.readline())
            process.wait(timeout=2)
            self.assertEqual(os.getpgid(grandchild), process.pid)
            cli._stop_group(process)
            with self.assertRaises(ProcessLookupError):
                os.killpg(process.pid, 0)
            with self.assertRaises(ProcessLookupError):
                os.kill(grandchild, 0)
        finally:
            cli._stop_group(process)
            process.stdout.close()

    def test_cleanup_failure_never_returns_success_and_retains_primary_context(self):
        real_stop = cli._stop_group
        def unresolved(process):
            real_stop(process)  # No real synthetic process is leaked by this injection.
            raise cli.BrowserOrdersError('DIA_CLEANUP_FAILED')
        with patch.object(cli, '_stop_group', side_effect=unresolved):
            with self.assertRaisesRegex(cli.BrowserOrdersError, '^DIA_CLEANUP_FAILED$') as caught:
                cli._bounded_process([sys.executable, '-c', 'print("x"*10000)'], timeout=2, max_bytes=100)
            self.assertEqual(str(caught.exception.__context__), 'DIA_RESPONSE_TOO_LARGE')
            with self.assertRaisesRegex(cli.BrowserOrdersError, '^DIA_CLEANUP_FAILED$'):
                cli._bounded_process([sys.executable, '-c', 'print("ok")'], timeout=2)
        code, result, _ = self.invoke(['orders'], error=cli.BrowserOrdersError('DIA_CLEANUP_FAILED'))
        self.assertEqual((code, result['error']), (1, 'DIA_CLEANUP_FAILED'))
        self.assertFalse(result['terminal'])

    def test_deadline_kills_child_and_grandchild_group(self):
        original = subprocess.Popen
        pid = []
        def capture(*args, **kwargs):
            p = original(*args, **kwargs)
            pid.append(p.pid)
            return p
        # Child + grandchild are synthetic sleepers, never Dia or a network client.
        script = 'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"]); time.sleep(60)'
        start = time.monotonic()
        with patch.object(cli.subprocess, 'Popen', side_effect=capture):
            with self.assertRaisesRegex(cli.BrowserOrdersError, '^DIA_TIMEOUT$'):
                cli._bounded_process([sys.executable, '-c', script], timeout=0.2)
        self.assertLess(time.monotonic() - start, 2)
        gone = False
        for _ in range(30):
            try:
                os.killpg(pid[0], 0)
            except ProcessLookupError:
                gone = True
                break
            time.sleep(0.01)
        self.assertTrue(gone, 'synthetic subprocess group leaked')

    def test_interrupt_also_reaps_transport_group(self):
        original = subprocess.Popen
        pid = []
        def capture(*args, **kwargs):
            p = original(*args, **kwargs)
            pid.append(p.pid)
            return p
        with patch.object(cli.subprocess, 'Popen', side_effect=capture), \
                patch.object(cli.selectors, 'DefaultSelector', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                cli._bounded_process([sys.executable, '-c', 'import time; time.sleep(60)'], timeout=2)
        with self.assertRaises(ProcessLookupError):
            os.killpg(pid[0], 0)

    def test_sigterm_converts_to_cleanup_interrupt(self):
        with self.assertRaises(KeyboardInterrupt):
            cli._interrupt(None, None)

    def test_no_transport_auth_navigation_or_external_code_flags(self):
        code, result, call = self.invoke(['orders', '--expression', 'private'])
        self.assertEqual(result['error'], 'INVALID_ARGUMENTS')
        call.assert_not_called()


if __name__ == '__main__':
    unittest.main()

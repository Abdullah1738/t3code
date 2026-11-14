"""Final exec size, rather than caller script size, selects the command transport."""
import contextlib
import hashlib
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
from offbox_lib import api, cli, common, misc, runs
from test_capacity import Isolated


FAILURE = ('/usr/local/sbin/boatd-wrap: line 22: /usr/bin/env: Argument list too long\n'
           '/usr/local/sbin/boatd-wrap: line 22: /usr/bin/env: Success\n'
           'Error: Command not executable\n')


class TransportTests(unittest.TestCase):
    def test_stalled_cleanup_cannot_hold_the_exit_receipt_or_wrapper(self):
        with tempfile.TemporaryDirectory() as home:
            root = Path(home)
            commands = root / 'bin'
            commands.mkdir()
            rm = commands / 'rm'
            rm.write_text('#!/bin/bash\nexec sleep 30\n')
            rm.chmod(0o700)
            path = root / '.offbox/cmd/run-file.sh'
            path.parent.mkdir(parents=True)
            path.write_text('exit 4')
            cmd = runs.exit_recording_command('exit 4', 'run-file', script_file=str(path))
            cmd = cmd.replace('bash -l ', 'bash ')
            p = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                               env={'HOME': home, 'PATH': str(commands) + ':' + os.environ['PATH']}, timeout=10)
            self.assertEqual(p.returncode, 4, p.stderr)
            self.assertEqual((root / '.offbox/exit/run-file.rc').read_text().strip(), '4')

    def test_small_command_is_byte_for_byte_unchanged(self):
        cmd, path = runs.command_payload('echo SMALL_OK', 'run-small')
        self.assertIsNone(path)
        self.assertEqual(hashlib.sha256(cmd.encode()).hexdigest(),
                         '57a000e386d39504da3da2f562440825ae44ad9f0d8b05d98c58c7f9138baeba')

    def test_final_bytes_include_crpko_and_node_preambles(self):
        with tempfile.TemporaryDirectory() as d, patch.object(api, 'BACKEND', 'server'):
            root = Path(d)
            (root / '.nvmrc').write_text('22')
            node = runs.node_version.block(runs.node_version.want(root, root))
            self.assertGreater(len(node), 7000)
            self.assertGreater(len(runs.repo_setup_block('crpko-devops', 'w/repo')), 43000)
            for count in (39, 200):
                with self.subTest(count=count):
                    script = runs.remote_script('w/repo', '.', [], None, 'run-large',
                        steps=[f'echo step{n}; #' + 'x' * 130 for n in range(count)], node=node,
                        repo_key='crpko-devops', repo_root=root, wait_images=True)
                    inline = runs.exit_recording_command(script, 'run-large')
                    self.assertGreater(len(inline.encode()), 131072)
                    command, path = runs.command_payload(script, 'run-large')
                    self.assertEqual(path, '/home/user/.offbox/cmd/run-large.sh')
                    self.assertLess(len(command.encode()), runs.COMMAND_INLINE_MAX)

    def test_quote_heavy_python_and_large_single_script_use_file(self):
        for backend in ('server', 'boat'):
            for script in ("python3 -I -c " + shlex.quote("v = 'quoted'\n" * 4100), 'true\n' * 40000):
                with self.subTest(backend=backend, bytes=len(script.encode())), patch.object(api, 'BACKEND', backend):
                    command, path = runs.command_payload(script, 'run-large')
                    self.assertIsNotNone(path)
                    self.assertLess(len(command.encode()), runs.COMMAND_INLINE_MAX)

    def test_file_preserves_pipefail_steps_receipt_and_cleanup(self):
        with tempfile.TemporaryDirectory() as home:
            script = runs.steps_block(['false | cat', 'echo second', 'exit 4'])
            path = Path(home) / '.offbox/cmd/run-file.sh'
            path.parent.mkdir(parents=True)
            path.write_text(script)
            cmd = runs.exit_recording_command(script, 'run-file', script_file=str(path))
            # Login-shell HOME is host controlled; use the test HOME for receipts.
            cmd = cmd.replace('bash -l ', 'bash ')
            p = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                               env={'HOME': home, 'PATH': os.environ['PATH']}, timeout=20)
            self.assertEqual(p.returncode, 1, p.stderr)
            self.assertIn('second', p.stdout)
            self.assertIn('offbox step 3 rc=4', p.stderr)
            self.assertEqual((Path(home) / '.offbox/exit/run-file.rc').read_text().strip(), '1')
            self.assertFalse(path.exists())


class RunTransportTests(Isolated):
    def test_foreground_wrapper_failure_has_one_explanation(self):
        self.box('bx', member=True)
        a = cli.build_parser().parse_args(['run', '--no-fallback', '--step', 'true'])
        row = dict(box_id='bx', remote_dir='w/repo', size='large')
        def follow(box, pid, log_path, **kwargs):
            Path(log_path).write_text(FAILURE)
            return 126
        err = io.StringIO()
        with patch.object(runs.pool, 'acquire', return_value=row), \
                patch.object(runs.Runner, '_prepare_box', return_value=None), patch.object(runs, '_ttl_keeper'), \
                patch.object(runs.lease, 'touch'), patch.object(runs.lease, 'idle_ttl'), \
                patch.object(api, 'cmd_start', return_value={'processId': 42}), \
                patch.object(runs, 'follow', side_effect=follow), \
                patch.object(misc, '_catch_up_log', return_value='complete'), contextlib.redirect_stderr(err):
            self.assertEqual(cli.cmd_run(a, self.me), 126, err.getvalue())
        self.assertEqual(err.getvalue().count('the box could not start the command'), 1)
        self.assertNotIn('steps incomplete', err.getvalue())

    def test_file_is_uploaded_and_transport_facts_are_recorded(self):
        self.box('bx', member=True)
        a = cli.build_parser().parse_args(['run', '--', 'true\n' * 40000])
        a.no_sync = True
        runner = runs.Runner(a, self.me)
        row = dict(box_id='bx', remote_dir='w/repo', size='large')
        with patch.object(runs.pool, 'acquire', return_value=row), \
                patch.object(runner, '_check_box', return_value=None), \
                patch.object(runs, '_ttl_keeper'), \
                patch.object(runs.lease, 'touch'), patch.object(runs.ssh_sync, 'put_file') as upload, \
                patch.object(api, 'cmd_start', return_value={'processId': 42, 'commandId': 'cmd-42'}) as send:
            runner.start()
        self.assertEqual(upload.call_count, 2)
        self.assertIn('/.offbox/cmd/', upload.call_args.args[1])
        self.assertIn(b'true\n' * 40000, upload.call_args.args[2])
        self.assertEqual(upload.call_args.args[3], '600')
        command = send.call_args.args[1]
        saved = self.con.execute('SELECT * FROM runs WHERE run_id=?', (runner.run_id,)).fetchone()
        self.assertEqual((saved['cmd_bytes'], saved['cmd_via']), (len(command.encode()), 'file'))
        self.assertIn('cmd_bytes=', self.con.execute("SELECT detail FROM events WHERE kind='run_start'").fetchone()[0])

    def test_guard_precedes_pool_acquire(self):
        a = cli.build_parser().parse_args(['run', '--', 'true'])
        runner = runs.Runner(a, self.me)
        with patch.object(runs, 'COMMAND_INLINE_MAX', 1), patch.object(runs.pool, 'acquire') as acquire:
            with self.assertRaises(common.OffboxError) as error:
                runner.start()
        self.assertEqual(error.exception.code, 2)
        self.assertIn('put the steps in a script file', str(error.exception))
        self.assertIn('in a file read by the command', str(error.exception))
        acquire.assert_not_called()

    def test_never_started_e2big_bypasses_missing_steps_only(self):
        path = Path(self.tmp.name) / 'failure.log'
        row = dict(run_id='r', cmd_bytes=140111, command_id=None, step_count=39)
        for marker, expected in (('', 126), (runs.COMMAND_STARTED_MARKER + ' r\n', None),
                                 (runs.run_evidence.PREFIX + 'wrapper pid=42\n', None)):
            with self.subTest(marker=marker):
                path.write_text(marker + FAILURE)
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    code = runs.settled_steps_code(row, 126, log_path=path, catch_up=False)
                self.assertEqual(code, expected)
                if expected == 126:
                    self.assertEqual(len(err.getvalue().splitlines()), 1)
                    self.assertIn('argument list too long, 140111 bytes', err.getvalue())
                    self.assertIn('in a file read by the command', err.getvalue())
                    self.assertNotIn('steps incomplete', err.getvalue())

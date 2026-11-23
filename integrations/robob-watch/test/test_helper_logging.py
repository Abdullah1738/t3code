"""Exercise real shell and Python helper boundaries without external services."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import datetime as dt
import importlib.util
import json
from pathlib import Path
import subprocess
import shlex
import sys
import tempfile
import unittest
from unittest.mock import patch

HELPERS = Path(__file__).resolve().parents[1] / 'helpers'
spec = importlib.util.spec_from_file_location('helper_log_fixture', HELPERS / 'toollog.py')
log = importlib.util.module_from_spec(spec)
spec.loader.exec_module(log)


class HelperLoggingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = dict(os.environ, ROBOB_TEST='1', WATCH_ID='fixture', TOOLLOG_DIR=str(self.root / 'logs'))

    def rows(self):
        return [log.expand_helper(json.loads(line)) for p in (self.root / 'logs').glob('*.ndjson') for line in p.read_text().splitlines()]

    def test_real_shell_helper_success_and_failure_preserve_stdout_and_exit(self):
        good = subprocess.run(['/bin/zsh', str(HELPERS / 'time-reached'), '2000-01-01T00:00:00+00:00', 'PRIVATE_TEXT'], env=self.env, capture_output=True, text=True)
        bad = subprocess.run(['/bin/zsh', str(HELPERS / 'time-reached'), 'PRIVATE_INVALID_DATE'], env=self.env, capture_output=True, text=True)
        self.assertEqual((good.returncode, good.stdout), (0, 'PRIVATE_TEXT\n'))
        self.assertNotEqual(bad.returncode, 0)
        rows = self.rows()
        self.assertEqual([row['name'] for row in rows], ['helper.run', 'helper.run'])
        self.assertEqual([row['ok'] for row in rows], [True, False])
        self.assertEqual([row['props']['exitCode'] for row in rows], [0, bad.returncode])
        self.assertTrue(all(row['ids']['helper'] == 'time-reached' for row in rows))
        self.assertNotIn('PRIVATE', json.dumps(rows))

    def test_shell_helpers_skip_startup_output_exit_and_side_effects(self):
        clean = self.root / 'clean-zdotdir'
        dirty = self.root / 'dirty-zdotdir'
        clean.mkdir()
        dirty.mkdir()
        startup_cases = (
            ('stdout', 'print -r -- STARTUP_OUTPUT\n'),
            ('exit', 'exit 73\n'),
            ('file', 'print -r -- changed > "$STARTUP_MARKER"\n'),
            ('options', 'setopt XTRACE\n'),
        )
        helper_cases = (
            ('time-reached', ['2999-01-01T00:00:00+00:00', 'PRIVATE_TEXT'], 0, ''),
            ('time-reached', ['2000-01-01T00:00:00+00:00', 'PRIVATE_TEXT'], 0, 'PRIVATE_TEXT\n'),
            ('time-reached', [], 2, ''),
            ('output-changed', [], 2, ''),
            ('email-new-message', [], 1, ''),
            ('whatsapp-new-message', [], 1, ''),
        )
        for effect, startup in startup_cases:
            (dirty / '.zshenv').write_text(startup)
            for index, (helper, args, code, stdout) in enumerate(helper_cases):
                with self.subTest(effect=effect, helper=helper, args=args):
                    marker = self.root / ('startup-' + effect + '-' + str(index))
                    command = [str(HELPERS / helper), *args]
                    baseline = subprocess.run(command, env=dict(self.env, ZDOTDIR=str(clean)), capture_output=True, text=True)
                    result = subprocess.run(command, env=dict(self.env, ZDOTDIR=str(dirty), STARTUP_MARKER=str(marker)),
                                            capture_output=True, text=True)
                    self.assertEqual((baseline.returncode, baseline.stdout), (code, stdout))
                    self.assertEqual((result.returncode, result.stdout, result.stderr),
                                     (baseline.returncode, baseline.stdout, baseline.stderr))
                    self.assertFalse(marker.exists())
        self.assertNotIn('STARTUP_OUTPUT', json.dumps(self.rows()))

    def test_main_wrapper_preserves_return_values_and_exceptions(self):
        def failure():
            raise SystemExit('PRIVATE_FAILURE')
        with patch.dict(os.environ, self.env):
            self.assertEqual(log.helper_main('fixture', lambda: 7), 7)
            with self.assertRaisesRegex(SystemExit, 'PRIVATE_FAILURE'):
                log.helper_main('fixture', failure)
        self.assertEqual([row['props']['exitCode'] for row in self.rows()], [7, 1])
        self.assertNotIn('PRIVATE', json.dumps(self.rows()))

    def test_python_helper_main_emits_success_and_failure_without_payload(self):
        for args in (['health'], ['unknown-private-command']):
            subprocess.run([sys.executable, str(HELPERS / 'wa-db'), *args], env=dict(self.env, WACLI_STORE_DIR=str(self.root / 'store')), capture_output=True)
        rows = self.rows()
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row['ids']['helper'] == 'wa-db' for row in rows))
        self.assertNotIn('private', json.dumps(rows))

    def test_shell_retention_cap_privacy_and_failed_sink(self):
        directory = self.root / 'logs'
        directory.mkdir()
        old = directory / '2000-01-01.ndjson'
        old.write_text('old')
        script = self.root / 'fixture.zsh'
        script.write_text('source "' + str(HELPERS / 'toollog.zsh') + '" fixture "$0" "$@"; exit "$1"\n')
        def run(code, **env):
            return subprocess.run(['/bin/zsh', '-f', str(script), str(code)],
                                  env=dict(self.env, WATCH_ID='PRIVATE 123456', **env), capture_output=True)
        self.assertEqual(run(0).returncode, 0)
        self.assertFalse(old.exists())
        self.assertNotIn('PRIVATE', json.dumps(self.rows()))
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        day = dt.datetime.now(dt.timezone.utc).date().isoformat()
        path = directory / (day + '.ndjson')
        cap = 50 * 1024 * 1024 + 1
        with path.open('r+b') as target:
            target.truncate(cap)
        for code in (0, 0, 7):
            self.assertEqual(run(code).returncode, code)
        with path.open('rb') as source:
            source.seek(cap)
            tail = source.read().decode()
        self.assertEqual(tail.count('"name":"log.cap"'), 1)
        self.assertEqual(tail.count('"name":"helper.run"'), 1)
        self.assertIn('"exitCode":7', tail)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(run(7, TOOLLOG_DIR='/dev/null/blocked').returncode, 7)

    def test_fixture_stderr_classes_at_python_and_shell_boundaries(self):
        fixtures = json.loads(Path(__file__).with_name('stderr-fixtures.json').read_text())
        for fixture in fixtures:
            for code in (1, 2):
                for language in ('python', 'shell'):
                    with self.subTest(fixture=fixture, code=code, language=language):
                        script = self.root / 'fixture.py'
                        script.write_text('import sys\nsys.path.insert(0, ' + repr(str(HELPERS)) + ')\n'
                                          'from toollog import helper_main\n'
                                          'def main():\n    sys.stderr.write(' + repr(fixture['stderr']) + ')\n    return ' + str(code) + '\n'
                                          'sys.exit(helper_main("fixture", main))\n')
                        command = [sys.executable, str(script)]
                        if language == 'shell':
                            shell = self.root / 'fixture.zsh'
                            # The stderr originates in a child process too, not just shell builtins.
                            shell.write_text('source "' + str(HELPERS / 'toollog.zsh') + '" fixture "$0" "$@"\n'
                                             + shlex.quote(sys.executable) + ' -c ' + shlex.quote(
                                                 'import sys; sys.stderr.write(' + repr(fixture['stderr']) + '); sys.exit(' + str(code) + ')') + '\n')
                            command = ['/bin/zsh', '-f', str(shell)]
                        result = subprocess.run(command, env=self.env, capture_output=True, text=True)
                        self.assertEqual((result.returncode, result.stdout, result.stderr), (code, '', fixture['stderr'].replace('\r\n', '\n')))
                        row = self.rows()[-1]
                        self.assertEqual(row['props']['stderrClass'], fixture['class'])
                        self.assertEqual(row['props']['stderrLines'], fixture['lines'])
                        self.assertRegex(row['props']['stderrHash'], r'^[a-f0-9]{16}$')
                        self.assertNotIn('PRIVATE', json.dumps(row))
                        self.assertNotIn(str(self.root), json.dumps(row))

    def test_uncaught_exceptions_and_systemexit_are_classified_without_changing_traceback(self):
        for expression, expected in (("FileNotFoundError('PRIVATE')", 'missing_file'),
                                     ("PermissionError('PRIVATE')", 'permission'),
                                     ("TimeoutError('PRIVATE')", 'timeout'),
                                     ("RuntimeError('PRIVATE')", 'python_traceback'),
                                     ("SystemExit('ride-card: not a bridge chat slug: PRIVATE')", 'usage_error')):
            with self.subTest(expression=expression):
                script = self.root / 'exception.py'
                script.write_text('import sys\nsys.path.insert(0, ' + repr(str(HELPERS)) + ')\nfrom toollog import helper_main\n'
                                  'def main():\n    raise ' + expression + '\nhelper_main("fixture", main)\n')
                result = subprocess.run([sys.executable, str(script)], env=self.env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 1)
                self.assertIn('PRIVATE', result.stderr)
                self.assertEqual(self.rows()[-1]['props']['stderrClass'], expected)
                self.assertNotIn('PRIVATE', json.dumps(self.rows()[-1]))

    def test_streaming_and_path_normalization_match_typescript_fixtures(self):
        for fixture in json.loads(Path(__file__).with_name('stderr-fixtures.json').read_text()):
            cause = log.StderrCause()
            for char in fixture['stderr']:
                cause.add(char)
            self.assertEqual(cause.props(), log.stderr_cause(fixture['stderr']))
        expected = log.stderr_cause('PRIVATE failure 987 /different/private456\n')['stderrHash']
        for path in ('/Users/private/a123', '"/Users/private/a b123"', "'../private/a b123'", 'C:\\private\\a123', '~/private/a123'):
            self.assertEqual(log.stderr_cause('PRIVATE failure 123 ' + path + '\n')['stderrHash'], expected)

    def test_cause_metadata_drops_raw_values_and_invalid_types(self):
        with patch.dict(os.environ, self.env):
            log.tool_error('helpers', 'fixture.failed', props={'stderrClass': 'PRIVATE', 'stderrLines': -1,
                           'stderrHash': 'PRIVATE', 'errnoCode': 'PRIVATE', 'signal': 'PRIVATE',
                           'timedOut': 'PRIVATE', 'triggerKind': '/PRIVATE', 'stderr': 'PRIVATE'})
        self.assertNotIn('props', self.rows()[0])

    def test_metadata_failures_preserve_return_and_exception(self):
        with patch.object(log.StderrCause, 'props', side_effect=OSError('PRIVATE')):
            self.assertEqual(log.helper_main('fixture', lambda: 2), 2)
            with self.assertRaisesRegex(SystemExit, 'PRIVATE'):
                log.helper_main('fixture', lambda: sys.exit('PRIVATE'))

    def test_python_inherited_subprocess_stderr_and_raw_fd_writes_are_classified(self):
        script = self.root / 'fixture.py'
        script.write_text('import sys, os, subprocess\nsys.path.insert(0, ' + repr(str(HELPERS)) + ')\n'
                          'from toollog import helper_main\n'
                          'def main():\n'
                          '    os.write(2, b"PRIVATE first line\\n")\n'
                          '    subprocess.run([sys.executable, "-c", "import sys; sys.stderr.write(\'PRIVATE Permission denied\\\\n\')"])\n'
                          '    return 2\nsys.exit(helper_main("fixture", main))\n')
        result = subprocess.run([sys.executable, str(script)], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr, 'PRIVATE first line\nPRIVATE Permission denied\n')
        self.assertEqual(self.rows()[-1]['props']['stderrClass'], 'permission')
        self.assertEqual(self.rows()[-1]['props']['stderrLines'], 2)
        self.assertNotIn('PRIVATE', json.dumps(self.rows()))

    def test_shell_preserves_stdin_arguments_and_signals(self):
        script = self.root / 'fixture.zsh'
        script.write_text('source "' + str(HELPERS / 'toollog.zsh') + '" fixture "$0" "$@"\n'
                          'read -r value; print -r -- "$1:$value"; kill -$2 $$\n')
        for name, number in (('TERM', 15), ('KILL', 9)):
            result = subprocess.run(['/bin/zsh', '-f', str(script), 'PRIVATE arg', name],
                                    input='PRIVATE input\n', env=self.env, capture_output=True, text=True)
            self.assertEqual(result.returncode, -number)
            self.assertEqual(result.stdout, 'PRIVATE arg:PRIVATE input\n')
            self.assertEqual(result.stderr, '')
            self.assertEqual(self.rows()[-1]['props']['stderrClass'], 'unknown')

    def test_cli_drops_invalid_arguments_and_io_failures(self):
        for args in ([], ['--bad', 'PRIVATE_VALUE'], ['--helper', 'fixture', '--duration-ms', '2', '--exit-code', '7']):
            result = subprocess.run([sys.executable, str(HELPERS / 'toollog.py'), *args], env=dict(self.env, TOOLLOG_DIR='/dev/null/blocked'), capture_output=True)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b'', b''))


if __name__ == '__main__':
    unittest.main()

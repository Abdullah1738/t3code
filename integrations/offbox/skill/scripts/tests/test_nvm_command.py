"""nvm compatibility before command admission, with no Node selection changes."""
import contextlib
import io
import json
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
from offbox_lib import api, cli, common, lease, misc, node_version, runs
from test_capacity import Isolated
import test_dependency_advice


class DetectorTests(unittest.TestCase):
    def test_input_matrix(self):
        positives = ['source ~/.nvm/nvm.sh', '. "$HOME/.nvm/nvm.sh"', '. $NVM_DIR/nvm.sh',
                     'source /home/user/.nvm/nvm.sh', 'test -s "$NVM_DIR/nvm.sh"',
                     '[ -s ~/.nvm/nvm.sh ]', '[[ -f "${HOME}/.nvm/nvm.sh" ]]',
                     'source "${NVM_DIR}/nvm.sh"', 'bash -c \'source "$HOME/.nvm/nvm.sh"\'']
        positives += ['nvm ' + action + ' 24' for action in ('use', 'install', 'exec', 'run')]
        negatives = ['node --version', 'pnpm nvmx', 'echo nvm.shell', 'nvmx use 24',
                     'source ~/.nvm/nvm.sh.bak', 'test -s "$NVM_DIR/nvm.sh.txt"']
        for command, expected in [(x, True) for x in positives] + [(x, False) for x in negatives]:
            with self.subTest(command=command):
                self.assertEqual(node_version.command_uses_nvm(command), expected)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.bin = self.home / 'bin'
        self.bin.mkdir()
        self.tool('node', 'echo v24.22.3')
        self.env = dict(HOME=str(self.home), PATH=f'{self.bin}:/usr/bin:/bin')

    def tool(self, name, body):
        file = self.bin / name
        file.write_text('#!/bin/bash\n' + body + '\n')
        file.chmod(0o755)

    def execute(self, *, fail=False, real_nvm=False):
        curl = '''while [ "$1" != -o ]; do shift; done
cat > "$2" <<'NVM'
nvm_process_parameters() {
  case " $* " in *' --no-use '*) return 0 ;; esac
  [ ! -f .nvmrc ] || return 3
}
nvm_process_parameters "$@"
NVM
echo fetched >> "$HOME/downloads"'''
        if real_nvm:
            fixture = Path(__file__).parent / 'fixtures/nvm-0.40.3/nvm.sh'
            curl = 'while [ "$1" != -o ]; do shift; done\ncp ' + shlex.quote(str(fixture)) + ' "$2"'
        self.tool('curl', 'exit 7' if fail else curl)
        script = node_version.command_nvm_block('run-test') + '''
echo 'offbox-command-started: run-test' >&2
before=$(command -v node)
source "$HOME/.nvm/nvm.sh"
[ "$before" = "$(command -v node)" ] || exit 42
node --version
command -v node
'''
        return subprocess.run(['bash', '-c', script], env=self.env, text=True, capture_output=True, timeout=10)

    def test_install_preserves_selected_node(self):
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.home / '.nvm/nvm.sh').is_file())
        self.assertIn('offbox-nvm-sh: run-test installed', result.stderr)
        self.assertIn('installed nvm.sh (nvm v0.40.3)', result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['v24.22.3', str(self.bin / 'node')])
        self.assertLess(result.stderr.index('installed nvm.sh'), result.stderr.index('offbox-command-started:'))

    def test_download_failure_stops_before_command(self):
        result = self.execute(fail=True)
        self.assertEqual(result.returncode, 99, result.stderr)
        self.assertIn('offbox-nvm-sh: run-test failed', result.stderr)
        self.assertIn('nvm.sh download failed (your command sources ~/.nvm/nvm.sh)', result.stderr)
        self.assertNotIn('offbox-command-started:', result.stderr)

    def test_existing_entrypoint_never_downloaded_or_sourced(self):
        target = self.home / '.nvm/nvm.sh'
        target.parent.mkdir()
        target.write_text('echo SOURCED\n')
        result = self.execute(fail=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('offbox-nvm-sh: run-test present', result.stderr)
        self.assertEqual(result.stdout.count('SOURCED'), 1)
        self.assertFalse((self.home / 'downloads').exists())

    def test_nvmrc_does_not_trigger_automatic_selection(self):
        (self.home / '.nvmrc').write_text('24\n')
        previous = Path.cwd()
        try:
            os.chdir(self.home)
            result = self.execute(real_nvm=True)
        finally:
            os.chdir(previous)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['v24.22.3', str(self.bin / 'node')])

    def test_default_alias_keeps_normal_auto_use(self):
        self.execute()
        alias = self.home / '.nvm/alias/default'
        alias.parent.mkdir()
        alias.write_text('24\n')
        (self.home / '.nvm/.offbox-nvm-v0.40.3.sh').write_text(
            'case " $* " in *" --no-use "*) exit 42 ;; esac\necho AUTO_USE\n')
        result = self.execute(fail=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('AUTO_USE', result.stdout)

    def test_later_shell_without_nvm_dir_can_source_entrypoint(self):
        self.assertEqual(self.execute(real_nvm=True).returncode, 0)
        result = subprocess.run(['bash', '-c', 'source "$HOME/.nvm/nvm.sh" && node --version'],
                                env=self.env, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'v24.22.3\n')

    def test_existing_custom_nvm_dir_is_preserved(self):
        custom = self.home / 'external nvm'
        custom.mkdir()
        (custom / 'nvm.sh').write_text('echo CUSTOM_SOURCE\n')
        for spelling in (str(custom), str(custom) + '/', 'external nvm'):
            with self.subTest(spelling=spelling):
                result = subprocess.run(['bash', '-c', node_version.command_nvm_block('run-test') +
                                         '\nsource "$NVM_DIR/nvm.sh"'], cwd=self.home,
                                        env=dict(self.env, NVM_DIR=spelling), text=True,
                                        capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, 'CUSTOM_SOURCE\n')
                self.assertIn('offbox-nvm-sh: run-test present', result.stderr)

    def test_unflagged_wrapper_has_no_bootstrap(self):
        script = runs.remote_script('w/repo', '.', ['node --version'], None, 'run-test', repo_root=self.home)
        self.assertNotIn('offbox-nvm-sh:', script)
        self.assertNotIn(node_version.NVM_FETCH, script)
        flagged = runs.remote_script('w/repo', '.', ['source ~/.nvm/nvm.sh'], None, 'run-test',
                                     repo_root=self.home, node='NODE_SELECTION_SENTINEL')
        self.assertLess(flagged.index('NODE_SELECTION_SENTINEL'), flagged.index('offbox-nvm-sh:'))
        self.assertLess(flagged.index('offbox-nvm-sh:'), flagged.index('echo "offbox-command-started:'))


class ClientTests(Isolated):
    def test_detected_and_setup_events_are_visible_in_run_event_view(self):
        for result in ('installed', 'failed', 'present'):
            with self.subTest(result=result):
                a = cli.build_parser().parse_args(['run', '--', 'test -s "$NVM_DIR/nvm.sh"'])
                with patch.object(lease, 'auto_size', return_value=('large', '')), \
                        contextlib.redirect_stderr(io.StringIO()):
                    runner = runs.Runner(a, self.me)
                    runner.register_pending()
                runner.log_path.write_text(f'offbox-nvm-sh: {runner.run_id} {result}\n')
                runs.nvm_result(runner.run_id, runner.log_path)
                runs.nvm_result(runner.run_id, runner.log_path)
                output = io.StringIO()
                with patch.object(misc, 'require_mine'), contextlib.redirect_stdout(output):
                    misc.run_events(runner.run_id, as_json=True)
                events = [row for row in json.loads(output.getvalue()) if row['kind'].startswith('nvm_')]
                self.assertEqual([row['kind'] for row in events],
                                 ['nvm_ref_detected'] + ([] if result == 'present' else [f'nvm_sh_{result}']))
                self.assertTrue(all(json.loads(row['detail'])['run_id'] == runner.run_id for row in events))

    def test_precommand_download_failure_keeps_step_exit_99(self):
        log = runs.LOGS_DIR / 'run-failed.log'
        for content, expected in (
                ('offbox-nvm-sh: run-failed failed\n', 99),
                ('offbox-command-started: run-failed\noffbox-nvm-sh: run-failed failed\n', None),
                ('offbox-nvm-sh: another failed\n', None)):
            with self.subTest(content=content):
                log.write_text(content)
                self.assertEqual(runs.checked_steps_code(log, 2, 99, report=False, run_id='run-failed'), expected)

    def test_recovered_stepped_setup_failure_keeps_durable_run_identity(self):
        original = runs.LOGS_DIR / 'run-failed.log'
        recovered = runs.LOGS_DIR / 'run-failed.log.remote'
        original.write_text('truncated\n')
        recovered.write_text('offbox-nvm-sh: run-failed failed\n')
        row = dict(run_id='run-failed', status='failed', step_count=2, mode='bg',
                   box_id='box', command_id='cmd', process_id=7, known_exit_code=99)
        with patch.object(misc, '_raw_log', return_value=recovered):
            self.assertEqual(runs.settled_steps_code(row, 99, log_path=original, catch_up=False), 99)

    def test_recovered_log_supplies_receipt_and_advice(self):
        run_id = 'run-recovered'
        runs.save_run_state(run_id, nvm_ref=True, nvm_sh=None)
        original, recovered = runs.LOGS_DIR / f'{run_id}.log', runs.LOGS_DIR / 'received.log'
        original.write_text('truncated\n')
        recovered.write_text(f'offbox-nvm-sh: {run_id} installed\n'
                             f'offbox-command-started: {run_id}\n'
                             'offbox: node v24.22.3 (box default)\n'
                             '/home/user/.nvm/nvm.sh: No such file or directory\n')
        with patch.object(misc, '_raw_log', return_value=recovered), patch.object(runs, 'event'):
            runs.nvm_result(run_id, original)
            hint = runs.box_deps_hint(Path(self.me['repo_root']), original)
        self.assertEqual(common.read_json(runs.LOGS_DIR / f'{run_id}.state.json', {})['nvm_sh'], 'installed')
        self.assertIn('Node v24.22.3 on PATH', hint)

    def test_warning_before_pool_admission_and_once(self):
        for backend, template, command, expected in (
                ('server', None, 'source ~/.nvm/nvm.sh', True),
                ('server', 'crpko-node', 'source ~/.nvm/nvm.sh', False),
                ('boat', None, 'source ~/.nvm/nvm.sh', False),
                ('server', None, 'node --version', False)):
            with self.subTest(backend=backend, template=template, command=command):
                self.con.execute('DELETE FROM runs')
                a = cli.build_parser().parse_args(['run', '--', command])
                a.template = template
                with patch.object(api, 'BACKEND', backend), patch.object(lease, 'auto_size', return_value=('large', '')), \
                        patch.object(runs, 'event') as event, contextlib.redirect_stderr(io.StringIO()) as output:
                    runner = runs.Runner(a, self.me)
                    runner.register_pending()
                    runner.register_pending()
                    runs.say('queued for a pool box')
                text = output.getvalue()
                self.assertEqual(text.count(runs.NVM_WARNING), int(expected), text)
                if expected:
                    self.assertLess(text.index(runs.NVM_WARNING), text.index('queued for a pool box'))
                saved = common.read_json(runs.LOGS_DIR / f'{runner.run_id}.state.json', {})
                self.assertEqual(saved['nvm_ref'], node_version.command_uses_nvm(command))
                self.assertIsNone(saved['nvm_sh'])
                self.assertEqual(sum(call.args[2] == 'nvm_ref_detected' for call in event.call_args_list),
                                 int(saved['nvm_ref']))

    def test_receipts_update_facts_and_emit_once_but_ignore_user_output(self):
        for result in ('installed', 'failed', 'present'):
            with self.subTest(result=result):
                run_id = 'run-' + result
                runs.save_run_state(run_id, nvm_ref=True, nvm_sh=None, box_id='box')
                log = runs.LOGS_DIR / f'{run_id}.log'
                log.write_text(f'offbox-nvm-sh: foreign failed\noffbox-nvm-sh: {run_id} {result}\n'
                               + (f'offbox-command-started: {run_id}\noffbox-nvm-sh: {run_id} failed\n'
                                  if result != 'failed' else ''))
                with patch.object(runs, 'event') as event:
                    runs.nvm_result(run_id, log)
                    runs.nvm_result(run_id, log)
                self.assertEqual(common.read_json(runs.LOGS_DIR / f'{run_id}.state.json', {})['nvm_sh'], result)
                self.assertEqual(event.call_count, int(result != 'present'))
                if result != 'present':
                    self.assertEqual(event.call_args.args[2], 'nvm_sh_' + result)
        log.write_text(f'offbox-command-started: {run_id}\noffbox-nvm-sh: {run_id} installed\n')
        runs.save_run_state(run_id, nvm_sh=None)
        runs.nvm_result(run_id, log)
        self.assertIsNone(common.read_json(runs.LOGS_DIR / f'{run_id}.state.json', {})['nvm_sh'])

    def test_null_state_is_safe(self):
        (runs.LOGS_DIR / 'run-null.state.json').write_text('null')
        runs.save_run_state('run-null', nvm_ref=True, nvm_sh=None)
        self.assertTrue(common.read_json(runs.LOGS_DIR / 'run-null.state.json', {})['nvm_ref'])


class NvmAdviceTests(unittest.TestCase):
    setUp = test_dependency_advice.DependencyAdviceTests.setUp
    manifest = test_dependency_advice.DependencyAdviceTests.manifest
    tool = test_dependency_advice.DependencyAdviceTests.tool
    run_command = test_dependency_advice.DependencyAdviceTests.run_command

    def test_hidden_source_error_replaces_dependency_advice(self):
        (self.root / 'scripts/x.sh').write_text('source "$HOME/.nvm/nvm.sh" || exit 1\n')
        result, hint = self.run_command('bash scripts/x.sh && npm ci && node --version')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('your command sourced ~/.nvm/nvm.sh', hint)
        self.assertNotIn('node_modules is still missing', result.stderr + hint)
        self.assertNotIn('Install deps', hint)

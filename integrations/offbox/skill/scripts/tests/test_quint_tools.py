"""Pinned archive staging and PATH behavior, without touching a live box."""
import hashlib
import json
import sqlite3
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import common, java_version, node_tools, quint_tools, runs
from tests.test_capacity import Isolated


class QuintToolsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.archive = self.root / '.local/share/apalache-patched' / quint_tools.ARCHIVE_NAME
        self.archive.parent.mkdir(parents=True)
        self.archive.write_bytes(b'reviewed archive fixture')
        self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.addCleanup(patch.stopall)
        patch.object(Path, 'home', return_value=self.root).start()
        patch.object(common, 'person', return_value=None).start()
        self.ssh = patch.object(quint_tools.ssh_sync, 'ssh').start()
        self.upload = patch.object(quint_tools.ssh_sync, 'put_file').start()
        self.ssh.return_value.returncode = 1

    def test_archive_is_verified_before_upload_and_published_after_remote_hash_check(self):
        with patch.object(quint_tools, 'ARCHIVE_SHA', self.digest):
            quint_tools.ensure_archive('box')
        self.assertEqual(self.upload.call_args.args[2], self.archive.read_bytes())
        pending = self.upload.call_args.args[1]
        publish = self.ssh.call_args.args[1]
        self.assertIn(f'sha256sum {shlex.quote(pending)}', publish)
        self.assertIn(f'= {self.digest} && mv', publish)
        self.assertIn(quint_tools.REMOTE_ARCHIVE, publish)

    def test_corrupt_local_archive_never_uploads(self):
        with self.assertRaisesRegex(common.OffboxError, 'sha256 mismatch'):
            quint_tools.ensure_archive('box')
        self.upload.assert_not_called()

    def test_cached_verified_archive_does_not_upload_again(self):
        self.ssh.return_value.returncode = 0
        quint_tools.ensure_archive('box')
        self.upload.assert_not_called()

    def test_missing_archive_allows_unrelated_work_without_download(self):
        self.archive.unlink()
        quint_tools.ensure_archive('box')
        self.ssh.assert_not_called()
        self.upload.assert_not_called()

    def test_person_boxes_are_unchanged(self):
        with patch.object(common, 'person', return_value='moni'):
            quint_tools.ensure_archive('box')
            self.assertEqual(quint_tools.block(), ':')
        self.ssh.assert_not_called()

    def test_guard_precedes_repo_and_global_cli_after_cd_and_child_bash(self):
        repo = self.root / 'w/repo'
        (repo / 'child/node_modules/.bin').mkdir(parents=True)
        (repo / 'package.json').write_text('{}')
        for directory in (repo / 'node_modules/.bin', repo / 'child/node_modules/.bin'):
            directory.mkdir(parents=True, exist_ok=True)
            raw = directory / 'quint'
            raw.write_text('#!/bin/sh\necho RAW\n')
            raw.chmod(0o755)
        wrapper = self.root / 'fake-wrapper'
        wrapper.write_text('#!/bin/sh\necho GUARDED\n')
        with patch.object(quint_tools, 'wrapper_path', return_value=wrapper):
            script = quint_tools.block() + node_tools.block('w/repo')
        script += '\nquint; cd child && quint; bash -c quint\n'
        result = subprocess.run(['bash', '-c', script], cwd=repo,
                                env={'HOME': str(self.root), 'PATH': '/usr/bin:/bin'},
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['GUARDED'] * 3)

    def test_production_preamble_keeps_guard_after_java_activation(self):
        repo = self.root / 'w/repo'
        (repo / 'child').mkdir(parents=True)
        (repo / 'package.json').write_text('{}')
        jdk = self.root / 'jvm/java-21-openjdk-test'
        for directory in (repo / 'node_modules/.bin', repo / 'child/node_modules/.bin',
                          jdk / 'bin', self.root / 'node-commands'):
            directory.mkdir(parents=True, exist_ok=True)
            raw = directory / 'quint'
            raw.write_text('#!/bin/sh\necho RAW\n')
            raw.chmod(0o755)
        for name, body in (('javac', 'echo javac 21.0.13'), ('java', ':')):
            executable = jdk / 'bin' / name
            executable.write_text('#!/bin/sh\n' + body + '\n')
            executable.chmod(0o755)
        for directory in (repo / 'node_modules/.bin', repo / 'child/node_modules/.bin',
                          self.root / 'node-commands'):
            executable = directory / 'node'
            executable.write_text('#!/bin/sh\necho ' + ('SELECTED_NODE' if directory.name == 'node-commands'
                                                       else 'RAW_NODE') + '\n')
            executable.chmod(0o755)
        wrapper = self.root / 'fake-wrapper'
        wrapper.write_text('#!/bin/sh\necho GUARDED\n')
        java_shell = java_version.SHELL.replace('/usr/lib/jvm', str(self.root / 'jvm'))
        timeout = self.root / 'test-bin/timeout'
        timeout.parent.mkdir()
        timeout.write_text('#!/bin/sh\n[ "$1" != -k ] || shift 2\nshift\nexec "$@"\n')
        timeout.chmod(0o755)
        node_shell = ('export __offbox_node_commands="$HOME/node-commands"\n'
                      'export PATH="$__offbox_node_commands:$PATH"')
        for node in ('', node_shell):
            for rel in ('.', 'child'):
                for stepped in (False, True):
                    with self.subTest(node=bool(node), rel=rel, stepped=stepped), \
                            patch.object(quint_tools, 'wrapper_path', return_value=wrapper), \
                            patch.object(java_version, 'SHELL', java_shell), \
                            patch.multiple(runs, GO_REPAIR=':', DOCKER_REPAIR=':', LDCACHE_REPAIR=':',
                                           SQLITE_SETUP=':', WATCH_REPAIR=':', CACHE_OWNER_REPAIR=':'), \
                            patch.object(runs.userns, 'setup', return_value=':'), \
                            patch.object(runs.containers, 'script', return_value=':'):
                        invoke = 'quint verify' + ('; node' if node else '')
                        child = invoke + '; bash -c ' + shlex.quote(invoke)
                        command = ('[ "$JAVA_HOME" = "$HOME/jvm/java-21-openjdk-test" ] || exit 88; '
                                   + invoke + '; cd "$HOME/w/repo/child" && ' + invoke
                                   + '; bash -c ' + shlex.quote(child))
                        script = runs.remote_script('w/repo', rel, [] if stepped else [command], None, 'test',
                                                    steps=[command] if stepped else None,
                                                    repo_root=repo, node=node)
                        result = subprocess.run(['bash', '-c', script], cwd=self.root,
                                                env={'HOME': str(self.root),
                                                     'PATH': f'{timeout.parent}:/usr/bin:/bin',
                                                     'QUINT_BIN': '/caller/quint'},
                                                capture_output=True, text=True, timeout=10)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(result.stdout.splitlines(),
                                         (['GUARDED', 'SELECTED_NODE'] if node else ['GUARDED']) * 4)


class QuintRecoveryTests(Isolated):
    def test_stopped_box_history_records_quint_analytics_without_docker_bookkeeping(self):
        from offbox_lib import api, misc, reap
        self.box('bx_quint', member=True)
        self.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,pulls,start_at) "
                         "VALUES ('run-quint','bx_quint','cmd_quint',7,'running','bg','[]',?)", (common.now(),))
        self.con.commit()
        output = ('offbox-quint: {"attempt":"result","result":"installed","duration_s":6,"trigger":"command"}\n'
                  'offbox-command-started: run-quint\n0.33.1\n')
        def recover(*args, **kwargs):
            (runs.LOGS_DIR / 'run-quint.log').write_text(output)
            return 'complete'
        for state in ('archived', 'error', 'cancelled'):
            with self.subTest(state=state):
                self.con.execute("UPDATE runs SET status='running',exit_code=NULL,end_at=NULL")
                self.con.commit()
                (runs.LOGS_DIR / 'run-quint.log').unlink(missing_ok=True)
                with patch.object(api, 'cmd_status', return_value={'status': 'exited', 'running': False, 'exitCode': 0}), \
                        patch.object(misc, '_catch_up_finished', side_effect=recover), \
                        patch.object(runs, 'settle_docker') as docker, patch('toollog.emit') as emit:
                    reap._check_unlocked(self.con, 'bx_quint', state, False, [])
                    docker.assert_not_called()
                self.assertEqual(self.con.execute('SELECT count(*) FROM events WHERE kind="quint_ensure"').fetchone()[0], 1)
                analytics = [call for call in emit.call_args_list if call.args[:2] == ('run', 'run.quint_ensure')]
                self.assertEqual(len(analytics), 1 if state == 'archived' else 0)
                if analytics:
                    self.assertEqual(analytics[0].kwargs['props']['quint_result'], 'installed')
                    self.assertEqual(analytics[0].kwargs['duration_ms'], 6000)


class QuintCliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.calls = self.root / 'npm.calls'
        self.prefix = self.root / '.offbox/quint' / ('cli-' + quint_tools.CLI_VERSION)
        self.wrapper = self.bin / 'wrapper'
        self.wrapper.write_text('#!/bin/sh\nexec "$QUINT_BIN" "$@"\n')
        self.wrapper.chmod(0o755)
        self.fake_cli = '#!/bin/sh\necho ' + quint_tools.CLI_VERSION + '\n'
        npm = self.bin / 'npm'
        npm.write_text('''#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
[ "${NPM_RC:-0}" = 0 ] || exit "$NPM_RC"
[ "$1" = install ] && [ "$2" = -g ] && [ "$3" = --prefix ] || exit 81
[ "$5" = "@informalsystems/quint@$EXPECTED_VERSION" ] || exit 82
mkdir -p "$4/bin"
printf '#!/bin/sh\\necho %s\\n' "${NPM_VERSION:-$EXPECTED_VERSION}" > "$4/bin/quint"
chmod +x "$4/bin/quint"
''')
        npm.chmod(0o755)
        self.zsh = self.root / 'runtime/zsh'
        self.zsh.parent.mkdir()
        self.zsh.write_text('#!/bin/sh\n:\n')
        self.zsh.chmod(0o755)
        for name, body in (
            ('sudo', '[ "$1" != -n ] || shift\nexec "$@"'),
            ('apt-get', 'echo "$*" >> "$APT_CALLS"\n'
             '[ "${APT_RC:-0}" = 0 ] || exit "$APT_RC"\n'
             '[ "$1" != install ] || { printf "#!/bin/sh\\n:\\n" > "$ZSH"; chmod +x "$ZSH"; }')):
            executable = self.bin / name
            executable.write_text('#!/bin/bash\n' + body + '\n')
            executable.chmod(0o755)
        self.env = dict(HOME=str(self.root), PATH=f'{self.bin}:/usr/bin:/bin',
                        CALLS=str(self.calls), EXPECTED_VERSION=quint_tools.CLI_VERSION,
                        ZSH=str(self.zsh), APT_CALLS=str(self.root / 'apt.calls'))
        self.addCleanup(patch.stopall)
        patch.object(common, 'person', return_value=None).start()
        patch.object(quint_tools, 'wrapper_path', return_value=self.wrapper).start()

    def script(self, reason='command'):
        return ('set -e\n' + quint_tools.block(reason).replace('/bin/zsh', str(self.zsh)) +
                '\nprintf "BIN=%s\\n" "${QUINT_BIN-unset}"\n'
                'command -v quint\nquint --version\n')

    def execute(self, reason='command', **env):
        return subprocess.run(['bash', '-c', self.script(reason)], env=dict(self.env, **env),
                              text=True, capture_output=True, timeout=20)

    def events(self, result):
        return [json.loads(line[len(quint_tools.PREFIX):]) for line in result.stderr.splitlines()
                if line.startswith(quint_tools.PREFIX)]

    def test_cold_install_warm_reuse_and_guard_first(self):
        for expected in ('installed', 'present'):
            result = self.execute()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines()[0], f'BIN={self.prefix}/bin/quint')
            self.assertIn('/bin/quint', result.stdout.splitlines()[1])
            self.assertNotEqual(result.stdout.splitlines()[1], str(self.prefix / 'bin/quint'))
            self.assertEqual(result.stdout.splitlines()[-1], quint_tools.CLI_VERSION)
            self.assertIn('guarded; cli ' + expected, result.stderr)
            self.assertEqual(self.events(result)[-1]['result'], expected)
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)
        self.assertFalse(list(self.prefix.parent.glob('*.tmp.*')))

    def test_old_base_gets_wrapper_interpreter_and_failure_is_setup_99(self):
        self.zsh.unlink()
        result = self.execute(APT_RC='42')
        self.assertEqual(result.returncode, common.EXIT_TOOLCHAIN, result.stderr)
        self.assertIn('zsh-apt-exit-42', result.stderr)
        self.assertFalse(self.calls.exists())
        self.assertEqual(self.events(result)[-1]['result'], 'failed')
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.zsh.is_file())
        apt_before = (self.root / 'apt.calls').read_text()
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'apt.calls').read_text(), apt_before)

    def test_wrong_cached_version_is_replaced(self):
        (self.prefix / 'bin').mkdir(parents=True)
        (self.prefix / 'bin/quint').write_text('#!/bin/sh\necho 0.1\n')
        (self.prefix / 'bin/quint').chmod(0o755)
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.events(result)[-1]['result'], 'installed')
        self.assertEqual(result.stdout.splitlines()[-1], quint_tools.CLI_VERSION)

    def test_install_failure_and_version_mismatch_never_start_command(self):
        for env, reason in (({'NPM_RC': '42'}, 'npm-exit-42'),
                            ({'NPM_RC': '124'}, 'npm-exit-124'),
                            ({'NPM_VERSION': '0.1'}, 'version-mismatch')):
            with self.subTest(env=env):
                result = self.execute(**env)
                self.assertEqual(result.returncode, common.EXIT_TOOLCHAIN, result.stderr)
                self.assertEqual(result.stdout, '')
                self.assertIn(f'offbox: quint {quint_tools.CLI_VERSION} install failed ({reason}); set QUINT_BIN or retry', result.stderr)
                self.assertEqual(self.events(result)[-1]['result'], 'failed')
                self.assertFalse(self.prefix.exists())
                self.assertFalse(list(self.prefix.parent.glob('*.tmp.*')))

    def test_caller_override_is_preserved_without_install(self):
        custom = self.bin / 'custom'
        custom.write_text('#!/bin/sh\necho CUSTOM\n')
        custom.chmod(0o755)
        result = self.execute(QUINT_BIN=str(custom))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('BIN=' + str(custom), result.stdout)
        self.assertEqual(result.stdout.splitlines()[-1], 'CUSTOM')
        self.assertFalse(self.calls.exists())
        result = subprocess.run(['bash', '-c', quint_tools.block('command') + '\nprintf "<%s>" "$QUINT_BIN"'],
                                env=dict(self.env, QUINT_BIN=''), text=True, capture_output=True, timeout=10)
        self.assertEqual(result.stdout, '<>')
        self.assertFalse(self.calls.exists())

    def test_non_quint_run_only_stages_guard(self):
        script = quint_tools.block('')
        self.assertNotIn('npm install', script)
        result = subprocess.run(['bash', '-c', script + '\ncommand -v quint; test -z "${QUINT_BIN+x}"'],
                                env=self.env, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('/bin/quint', result.stdout)
        self.assertNotIn('offbox-quint:', result.stderr)
        self.assertFalse(self.calls.exists())

    def test_concurrent_runs_publish_once(self):
        self.check_concurrent_runs()

    def test_concurrent_old_base_repairs_runtime_once(self):
        self.zsh.unlink()
        self.check_concurrent_runs()
        self.assertEqual((self.root / 'apt.calls').read_text().splitlines(),
                         ['update -qq', 'install -y -qq zsh'])

    def check_concurrent_runs(self):
        children = [subprocess.Popen(['bash', '-c', self.script()], env=self.env,
                                    text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(4)]
        results = []
        for child in children:
            out, err = child.communicate(timeout=20)
            self.assertEqual(child.returncode, 0, err)
            self.assertEqual(out.splitlines()[-1], quint_tools.CLI_VERSION)
            results.append(err)
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)
        self.assertEqual(sum('cli installed' in err for err in results), 1)
        self.assertFalse((self.prefix / self.prefix.name).exists())

    def test_quint_command_trigger_corpus(self):
        cases = {
            'quint --version': True,
            '/opt/quint verify x.qnt': True,
            'env -S "quint --version"': True,
            'env --split-string "quint --version"': True,
            'env --split-string="quint --version"': True,
            'command -v quint': False,
            'command -V quint': False,
            'command -pv quint': False,
            'command -- quint --version': True,
            'env --split-string="echo quint"': False,
            'env X=1 bash -euc "quint verify x.qnt"': True,
            'npx @informalsystems/quint@0.33.1 verify x.qnt': True,
            'npm exec -- quint --version': True,
            'echo $(quint --version)': True,
            'bash scripts/check-quint.sh': True,
            'apalache-mc check': True,
            'true # quint verify': False,
            'echo "quint verify"': False,
            'rg quint README.md': False,
            'cat apalache.log': False,
            'java -version': False,
            'mvn test': False,
            'true': False,
        }
        for command, expected in cases.items():
            with self.subTest(command=command):
                self.assertEqual(quint_tools.trigger(self.root, '.', [command]), 'command' if expected else '')
        self.assertEqual(quint_tools.trigger(self.root, '.', [], ['true', 'quint --version']), 'command')
        self.assertEqual(quint_tools.trigger(self.root, '.', ['quint', '--version']), 'command')

    def test_nested_repo_spec_trigger(self):
        spec = self.root / 'specs/nested/probe.qnt'
        spec.parent.mkdir(parents=True)
        spec.write_text('module probe {}')
        self.assertEqual(quint_tools.trigger(self.root, '.', ['true']), 'repo-marker')

    def test_retry_analytics_and_final_prelude_failure(self):
        first = self.execute()
        # Compose retry diagnostics without letting an old command's output
        # supply the final prelude result.
        failure = json.dumps(dict(attempt='result', result='failed', duration_s=2, trigger='command'))
        path = self.root / 'retry.log'
        retry = 'offbox-server: the server restarted while this run was going (attempt 1 is lost); it is queued again as attempt 2\n'
        path.write_text(first.stderr + 'offbox-command-started: run-test\n' + first.stderr + retry +
                        quint_tools.PREFIX + failure + '\n')
        self.assertTrue(quint_tools.failed_setup(path))
        with sqlite3.connect(':memory:') as con:
            con.executescript('CREATE TABLE events(ts REAL,box_id TEXT,kind TEXT,detail TEXT); CREATE TABLE kv(k TEXT PRIMARY KEY,v TEXT);')
            with patch('toollog.emit') as emit:
                for _ in range(2):
                    quint_tools.record(con, dict(run_id='run-test', box_id='bx_test'), path, 'server')
                self.assertEqual(emit.call_count, 4)
                self.assertEqual(emit.call_args.kwargs['props']['attempt'], 2)
                self.assertEqual(emit.call_args.kwargs['props']['quint_result'], 'failed')
                self.assertFalse(emit.call_args.kwargs['ok'])
        path.write_text(path.read_text() + 'offbox-command-started: run-test\n')
        self.assertFalse(quint_tools.failed_setup(path))
        path.write_text(path.read_text() + retry)
        self.assertFalse(quint_tools.failed_setup(path))
        path.write_text(path.read_text() + quint_tools.PREFIX + '{invalid}\n')
        self.assertFalse(quint_tools.failed_setup(path))

    def test_analytics_persists_dedupes_and_ignores_command_output(self):
        result = self.execute()
        path = self.root / 'run.log'
        path.write_text(result.stderr + 'offbox-command-started: run-test\n' + result.stderr)
        with sqlite3.connect(':memory:') as con:
            con.executescript('CREATE TABLE events(ts REAL,box_id TEXT,kind TEXT,detail TEXT); CREATE TABLE kv(k TEXT PRIMARY KEY,v TEXT);')
            with patch.dict(os.environ, OFFBOX_TOOL_LOG_DIR=str(self.root / 'events')):
                for _ in range(2):
                    quint_tools.record(con, dict(run_id='run-test', box_id='bx_test'), path, 'server')
            rows = con.execute('SELECT kind,detail FROM events').fetchall()
            self.assertEqual(len(rows), 3)
            for kind, detail in rows:
                data = json.loads(detail)
                self.assertEqual(kind, 'quint_ensure')
                self.assertEqual(data['box'], 'bx_test')
                self.assertEqual(data['trigger'], 'command')
                self.assertGreaterEqual(data['duration_s'], 0)
            events = [json.loads(line) for file in (self.root / 'events').glob('*.ndjson')
                      for line in file.read_text().splitlines()]
            self.assertEqual(len(events), 3)
            self.assertEqual(events[-1]['props'], dict(quint_phase='result', quint_result='installed',
                                                     quint_trigger='command', backend='home', attempt=1))


if __name__ == '__main__':
    unittest.main()

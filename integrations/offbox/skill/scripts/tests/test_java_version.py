"""Java repair is opt-in, bounded, and advisory even under errexit."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import java_version, runs


class JavaSelection(unittest.TestCase):
    def test_command_forms(self):
        cases = ('java -version', '/usr/bin/javac Test.java', 'npx quint verify a.qnt',
                 'bash integrations/local-helpers/apalache/build-patched.sh out', 'sbt compile',
                 'mvn test', './gradlew build', './mvnw verify', 'gradle test',
                 "bash -lc 'quint verify x.qnt'", 'true && javac X.java', 'echo $(java -version)',
                 'apalache-mc check', '/opt/apalache/bin/apalache-mc check',
                 'bash verify-quint.sh', 'bash build-apalache.sh', 'npx @informalsystems/quint@0.31 verify')
        with tempfile.TemporaryDirectory() as tmp:
            for cmd in cases:
                with self.subTest(cmd=cmd):
                    self.assertEqual(java_version.trigger(Path(tmp), '.', [cmd]), 'command')

    def test_harness_and_non_java(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for key, template in (('harness', ''), ('crpko-integration-harness', ''), ('other', 'crpko-harness')):
                with self.subTest(key=key, template=template):
                    self.assertEqual(java_version.trigger(root, '.', ['pytest tests/test_kafka.py'],
                                                         repo_key=key, template=template), 'harness')
            for cmd in ('go test ./...', 'echo javascript', 'true # java -version'):
                self.assertEqual(java_version.trigger(root, '.', [cmd], repo_key='other', template='generic'), '')
            self.assertEqual(java_version.block(''), '')

    def test_executable_and_literal_argument_corpus(self):
        cases = (
            ('direct', 'java -version', True),
            ('absolute', '/usr/bin/javac Probe.java', True),
            ('search text', 'rg java README.md', False),
            ('quoted text', "echo 'sbt compile'", False),
            ('printf data', 'printf "%s" "gradle test"', False),
            ('file argument', 'cat apalache.log', False),
            ('shell code', "bash -lc 'java -version'", True),
            ('shell data', "bash -lc 'echo java'", False),
            ('shell flag group', "bash -euc 'java -version'", True),
            ('shell flag group data', "bash -euc 'echo java'", False),
            ('substitution code', 'echo $(java -version)', True),
            ('substitution data', 'echo $(echo java)', False),
            ('assignment', 'JAVA_HOME=/bad java -version', True),
            ('assignment data', 'JAVA_HOME=/bad echo javac', False),
            ('assignment value data', 'VAR=java echo hello', False),
            ('env option', 'env -u JAVA_HOME java -version', True),
            ('env option data', 'env -u JAVA_HOME echo java', False),
            ('env split', "env -S 'java -version'", True),
            ('env split data', "env -S 'echo java'", False),
            ('timeout', 'timeout -k 5 30 javac -version', True),
            ('sudo', 'sudo -n -u user java -version', True),
            ('sudo data', 'sudo -n echo java', False),
            ('nested shell', "sudo -n bash -c 'javac -version'", True),
            ('nested data', "sudo -n bash -c 'echo java'", False),
            ('npx', 'npx -y @informalsystems/quint@0.31 verify', True),
            ('pnpm exec', 'corepack pnpm exec quint verify', True),
            ('npm exec', 'npm exec --package @informalsystems/quint -- quint verify', True),
            ('npm package data', 'npm exec --package @informalsystems/quint -- echo java', False),
            ('manager options', 'pnpm --dir java exec echo java', False),
            ('manager options executable', 'pnpm --dir tools exec quint verify', True),
            ('shell script', 'bash -eu verify-quint.sh', True),
            ('script argument', 'bash helper.sh quint', False),
            ('python literal', "python3 -c 'print(\"java\")'", False),
            ('loop data', 'for x in java javac; do echo "$x"; done', False),
            ('comment', 'go test ./... # sbt compile', False),
        )
        with tempfile.TemporaryDirectory() as tmp:
            for name, cmd, expected in cases:
                with self.subTest(form=name, cmd=cmd):
                    self.assertEqual(java_version.trigger(Path(tmp), '.', [cmd]) == 'command', expected)

    def test_markers_at_root_sent_and_command_directories(self):
        for marker in ('build.sbt', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'model.qnt'):
            for directory in ('.', 'sent', 'nested'):
                with self.subTest(marker=marker, directory=directory), tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    (root / 'sent').mkdir(); (root / 'nested').mkdir()
                    (root / directory / marker).touch()
                    self.assertEqual(java_version.trigger(root, 'sent', ['cd ../nested && pytest']), 'repo-marker')

    def test_shell_value_options_and_runner_body_corpus(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            forms = (
                "bash -o pipefail -c {body}", "bash +o posix -c {body}",
                "bash -O extglob -c {body}", "bash +O extglob -c {body}",
                "bash -euo pipefail -c {body}", "bash +eo posix -c {body}",
                "bash --rcfile config -c {body}", "bash --rcfile java -c {body}",
                "bash --init-file=config -c {body}",
                "sudo -n bash -o pipefail -c {body}",
                "npm exec -c {body}", "npm exec --call {body}",
                "npm exec --call={body}", "npm exec -c={body}",
                "npx -c {body}", "npx --call {body}", "npx --call={body}", "npx -c={body}",
                "npm --prefix tools exec --package @informalsystems/quint --call={body}",
            )
            for form in forms:
                for body, expected in (("'javac -version'", True), ("'echo java'", False)):
                    with self.subTest(form=form, body=body):
                        self.assertEqual(java_version.trigger(root, '.', [form.format(body=body)]) == 'command', expected)

    def test_steps(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(java_version.trigger(Path(tmp), '.', [], ['true', 'sbt test']), 'command')

    def test_remote_script_includes_step_for_both_backends_and_actual_template(self):
        with tempfile.TemporaryDirectory() as tmp:
            for backend in ('boat', 'server'):
                with self.subTest(backend=backend), patch.object(runs.api, 'BACKEND', backend):
                    script = runs.remote_script('w/repo', '.', ['pytest'], None, 'run-test',
                                                repo_root=Path(tmp), template='crpko-harness')
                    self.assertIn('openjdk-21-jdk-headless', script)
                    self.assertLess(script.index('__offbox_find_jdk'), script.index(runs.COMMAND_STARTED_MARKER + ' run-test'))
                    script = runs.remote_script('w/repo', '.', ['go test ./...'], None, 'run-test',
                                                repo_root=Path(tmp), template='generic')
                    self.assertNotIn('__offbox_find_jdk', script)


class JavaActivation(unittest.TestCase):
    def fixture(self, state='present', caller_home=None, apt_rc=0, compiler_version='21.0.13', command='javac -version'):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); bindir = root / 'bin'; bindir.mkdir()
            jdk = root / 'jvm/java-21-openjdk-amd64'; (jdk / 'bin').mkdir(parents=True)
            log = root / 'apt.calls'
            def shim(path, body):
                path.write_text('#!/bin/bash\n' + body); path.chmod(0o755)
            compiler = '#!/bin/bash\necho javac ' + compiler_version + '\n'
            if state != 'missing':
                shim(jdk / 'bin/java', 'echo \'openjdk version "21.0.13"\' >&2\n')
            if state == 'present':
                shim(jdk / 'bin/javac', 'echo javac ' + compiler_version + '\n')
            if state == 'jre-only':
                shim(bindir / 'java', 'echo \'openjdk version "21.0.13"\' >&2\n')
            shim(bindir / 'sudo', '[ "$1" != -n ] || shift\nexec "$@"\n')
            shim(bindir / 'timeout', 'printf "timeout %s\\n" "$*" >> "$CALLS"\nshift 3\nexec "$@"\n')
            shim(bindir / 'apt-get', 'echo "apt-get $*" >> "$CALLS"\n'
                 'if [ "$1" = install ]; then\n [ "$APT_RC" = 0 ] || exit "$APT_RC"\n'
                 ' printf "%s" "$COMPILER" > "$JDK/bin/javac"; chmod +x "$JDK/bin/javac"\n'
                 ' printf \'#!/bin/bash\\necho java21\\n\' > "$JDK/bin/java"; chmod +x "$JDK/bin/java"\nfi\n')
            script = java_version.block('harness').replace('/usr/lib/jvm/', str(root / 'jvm') + '/')
            env = dict(PATH=f'{bindir}:/usr/bin:/bin', HOME=str(root), CALLS=str(log),
                       APT_RC=str(apt_rc), COMPILER=compiler, JDK=str(jdk))
            if caller_home:
                env['JAVA_HOME'] = caller_home
            result = subprocess.run(['/bin/bash', '-c', 'set -e\n' + script + '\necho JAVA_HOME=$JAVA_HOME\n' + command],
                                    env=env, text=True, capture_output=True, timeout=30)
            calls = log.read_text() if log.exists() else ''
            return result, calls, str(jdk)

    def test_present_overrides_missing_and_old_caller_home_without_apt(self):
        for home in (None, '/missing/jdk', '/usr/lib/jvm/java-11-openjdk-amd64'):
            with self.subTest(home=home):
                result, calls, jdk = self.fixture(caller_home=home)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('JAVA_HOME=' + jdk, result.stdout)
                self.assertIn('javac 21.0.13', result.stdout)
                self.assertNotIn('apt-get', calls)
                self.assertIn('offbox: java 21.0.13', result.stderr)

    def test_jre_only_and_missing_install_once_and_export(self):
        for state in ('jre-only', 'missing'):
            with self.subTest(state=state):
                result, calls, jdk = self.fixture(state=state)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(calls.splitlines().count('apt-get install -y -qq openjdk-21-jdk-headless'), 1)
                self.assertIn('timeout -k 5 300 sudo -n bash -c', calls)
                self.assertIn('JAVA_HOME=' + jdk, result.stdout)
                self.assertIn('javac 21.0.13', result.stdout)
                self.assertIn('installed, ', result.stderr)

    def test_apt_failure_and_wrong_compiler_warn_once_and_preserve_command_exit(self):
        for apt_rc, version in ((42, '21.0.13'), (124, '21.0.13'), (0, '17.0.1')):
            for command, code in (('exit 7', 7), ('true', 0)):
                with self.subTest(apt_rc=apt_rc, version=version, code=code):
                    result, _, _ = self.fixture(state='missing', caller_home='/caller', apt_rc=apt_rc,
                                                compiler_version=version, command=command)
                    self.assertEqual(result.returncode, code, result.stderr)
                    self.assertEqual(result.stderr.count('offbox: could not install JDK 21:'), 1)
                    self.assertIn('JAVA_HOME=/caller', result.stdout)

    def test_analytics_has_attempt_result_duration_box_backend_trigger_and_dedupes(self):
        result, _, _ = self.fixture(state='jre-only')
        with tempfile.TemporaryDirectory() as tmp, sqlite3.connect(':memory:') as con:
            path = Path(tmp) / 'run.log'; path.write_text(result.stderr)
            con.executescript('CREATE TABLE events(ts REAL,box_id TEXT,kind TEXT,detail TEXT); CREATE TABLE kv(k TEXT PRIMARY KEY,v TEXT);')
            with patch('toollog.emit') as emit:
                for _ in range(2):
                    java_version.record(con, dict(run_id='run-test', box_id='bx_test'), path, 'server')
                self.assertEqual(emit.call_count, 3)
                self.assertEqual(emit.call_args.kwargs['props']['jdk_result'], 'installed')
                import toollog
                props = emit.call_args.kwargs['props']
                self.assertEqual(toollog._props(props), props)
                self.assertEqual(props['backend'], 'home')
            rows = con.execute('SELECT kind,detail FROM events').fetchall()
            self.assertEqual(len(rows), 3)
            for kind, detail in rows:
                self.assertEqual(kind, 'java_ensure')
                data = json.loads(detail)
                self.assertEqual(data['box'], 'bx_test'); self.assertEqual(data['backend'], 'server')
                self.assertEqual(data['trigger'], 'harness'); self.assertGreaterEqual(data['duration_s'], 0)

    def test_real_analytics_writer_keeps_failure_metadata(self):
        result, _, _ = self.fixture(state='missing', caller_home='/caller', apt_rc=42, command='exit 7')
        with tempfile.TemporaryDirectory() as tmp, sqlite3.connect(':memory:') as con:
            root = Path(tmp); path = root / 'run.log'; path.write_text(result.stderr)
            con.executescript('CREATE TABLE events(ts REAL,box_id TEXT,kind TEXT,detail TEXT); CREATE TABLE kv(k TEXT PRIMARY KEY,v TEXT);')
            with patch.dict(os.environ, OFFBOX_LOG_DIR=str(root / 'events')):
                java_version.record(con, dict(run_id='run-fail', box_id='bx_test'), path, 'boat')
            events = [json.loads(line) for file in (root / 'events').glob('*.ndjson') for line in file.read_text().splitlines()]
            self.assertEqual(len(events), 3)
            self.assertEqual(events[-1]['props'], dict(jdk_phase='result', jdk_result='apt-failed',
                                                     jdk_trigger='harness', backend='boat', exitCode=42))
            self.assertFalse(events[-1]['ok'])
            self.assertEqual(events[-1]['ids'], dict(run='run-fail', box='bx_test'))
            self.assertIn('durationMs', events[-1])

"""Historical commands are source-inspected only, never executed."""
if __package__:
    from . import test_environment
else:
    import test_environment

import errno
import hashlib
import json
import os
from pathlib import Path
import sys
import shlex
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import test_relative_script_reporters as reporters
import statev2_guard as guard

FIXTURES = Path(__file__).with_name('fixtures') / 'guard-1006'
LIVE = reporters.LIVE
READ = 'live-database-read'
SCRIPT = 'live-database-script'
UNRESOLVED = 'live-database-script-unresolved'


class Reporter1006Tests(unittest.TestCase):
    setUp = reporters.RelativeScriptReporterTests.setUp
    write = reporters.RelativeScriptReporterTests.write
    check = reporters.RelativeScriptReporterTests.check
    event = reporters.RelativeScriptReporterTests.event

    def test_reporter_matrix(self):
        rows = [json.loads(path.read_text()) for path in sorted(FIXTURES.glob('*.json'))]
        self.assertEqual({row['case_number'] for row in rows}, set(range(1, 29)))
        for row in rows:
            files = {}
            for name, body in row.get('setup_files', {}).items():
                files[name] = self.write('retained/' + str(len(files)), body)
            for name, source in row.get('source_files', {}).items():
                files[name] = self.write('retained/' + str(len(files)), (reporters.ROOT.parents[1] / source).read_text())
            real_stat, real_open = Path.stat, Path.open
            def path_stat(path, *args, **kwargs):
                key = os.path.abspath(path)
                if key in files:
                    return real_stat(files[key], *args, **kwargs)
                raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), path)
            def path_open(path, *args, **kwargs):
                key = os.path.abspath(path)
                if key in files:
                    return real_open(files[key], *args, **kwargs)
                raise FileNotFoundError(path)
            for call in row['commands']:
                self.assertEqual(hashlib.sha256(call['cmd'].encode()).hexdigest(), call['sha256'])
                # Only retained/representative sources can be read. Nothing in
                # another task's current checkout participates in the replay.
                with patch.object(os.path, 'realpath', side_effect=lambda p, *a, **kw: os.path.abspath(p)), patch.object(Path, 'stat', autospec=True, side_effect=path_stat), patch.object(Path, 'open', autospec=True, side_effect=path_open):
                    for harness, tool in [('codex', 'exec_command'), ('codex', 'Bash'), ('claude', 'Bash')]:
                        event = self.event(call['cmd'], tool)
                        cwd = call.get('workdir') or row['session_cwd']
                        event['cwd'] = row['session_cwd'] if tool == 'exec_command' else cwd
                        event['tool_input'].pop('workdir')
                        if tool == 'exec_command' and call.get('workdir'):
                            event['tool_input']['workdir'] = call['workdir']
                        with self.subTest(case=row['case_number'], reporter=row['reporter_id'], command=call.get('label'), harness=harness, tool=tool):
                            self.check(event, call.get('expected'), harness)
                            if not call.get('expected'):
                                key = 'cmd' if tool == 'exec_command' else 'command'
                                event['tool_input'][key] += '\npython3 -c ' + shlex.quote(f'open({LIVE!r}).read()')
                                self.check(event, READ, harness)

    def test_existing_relative_and_absolute_scripts(self):
        path = self.write('tmp/existing.py', "print('safe')\n")
        invocations = ['python3 tmp/existing.py', f'python3 {path}',
                       'timeout 1200 uv run python tmp/existing.py',
                       'offbox run -- python3 tmp/existing.py']
        for database in (LIVE, reporters.OPENCODE):
            for body, expected in [("print('safe')\n", None), (f'open({database!r}).read()\n', SCRIPT)]:
                path.write_text(body)
                for command in invocations:
                    with self.subTest(command=command, expected=expected):
                        self.check(self.event(command), expected)

    def test_create_then_run_family(self):
        for name, body, invocations in [
            ('x.py', "print('safe')\n", ['python3 x.py', f'python3 {self.root}/x.py']),
            ('x.sh', 'echo safe\n', ['bash x.sh', 'sh x.sh', 'chmod +x x.sh && ./x.sh']),
        ]:
            self.assertFalse((self.root / name).exists())
            for invoke in invocations:
                command = f"cat > {name} <<'EOF'\n{body}EOF\n{invoke}"
                with self.subTest(command=invoke):
                    self.check(self.event(command))
                    read = f'open({LIVE!r}).read()' if name.endswith('.py') else f'sqlite3 {LIVE} .tables'
                    self.check(self.event(command.replace('\nEOF', '\n' + read + '\nEOF')), SCRIPT)

    def test_temporary_system_alias_create_then_run(self):
        path = self.root / 'alias.py'
        command = f"cat > {path} <<'PY'\nprint('safe')\nPY\npython3 {path}"
        # Model /tmp -> /private/tmp even on hosts without that system alias.
        realpath = os.path.realpath
        def resolve(value, *args, **kwargs):
            value = os.fspath(value)
            return realpath(value.replace('/tmp/card1006-alias.py', str(path)), *args, **kwargs)
        with patch.object(os.path, 'realpath', side_effect=resolve):
            command = command.replace(str(path), '/tmp/card1006-alias.py', 1)
            self.check(self.event(command))
            self.check(self.event(command.replace("print('safe')", f'open({LIVE!r}).read()')), SCRIPT)

    def test_database_names_in_proven_write_only_data(self):
        # Preserve main's distinction between inert data and an actual open.
        for body in ["cat > report.md <<'EOF'\n" + LIVE + '\nEOF\n',
                     "python3 - <<'PY'\nfrom pathlib import Path\nPath('report.md').write_text(" + repr(LIVE) + ')\nPY\n']:
            self.check(self.event(body))
            self.check(self.event(body + 'cat ' + LIVE), READ)

    def test_inline_and_stdin_live_controls(self):
        for database in (LIVE, reporters.OPENCODE, str(Path.home() / '.t3/userdata/statev2.sqlite')):
            code = f"from pathlib import Path\nPath('report.md').write_text('timeout 1200 uv run python tmp/missing.py')\nopen({database!r}).read()\n"
            for command in ["python3 - <<'PY'\n" + code + 'PY', 'python3 -c ' + shlex.quote(code)]:
                with self.subTest(database=database, command=command.splitlines()[0]):
                    self.check(self.event(command), READ)

    def test_parse_only_and_execute_modes(self):
        self.write('x.mjs', f'// fixture\nrequire("fs").readFileSync({LIVE!r})\n')
        self.write('x.sh', f'sqlite3 {LIVE} .tables\n')
        self.write('x.py', f'open({LIVE!r}).read()\n')
        rows = [
            ('node --check x.mjs', None), ('node -c x.mjs', None),
            ('node --check --no-warnings x.mjs', None),
            ('node --check "$UNKNOWN/script.mjs"', UNRESOLVED),
            ('cd "$UNKNOWN" && node --check x.mjs', UNRESOLVED),
            ('node --check x.mjs && node x.mjs', SCRIPT),
            ('node x.mjs --check', SCRIPT), ('node x.mjs -c', SCRIPT),
            ('node -- x.mjs --check', SCRIPT),
            ('node --test x.mjs', SCRIPT), ('node x.mjs', SCRIPT),
            ('bash -n x.sh', None), ('sh -n x.sh', None),
            (f'bash -n {self.root}/x.sh', None),
            ('bash -n x.sh && bash x.sh', SCRIPT),
            ('python3 -m py_compile x.py', None),
            ('python3 -m py_compile x.py && python3 x.py', SCRIPT),
            ('node --check x.mjs < ' + LIVE, READ),
            ('node --check ' + LIVE, READ),
            ('node --check --require x.mjs x.mjs', SCRIPT),
        ]
        for command, expected in rows:
            with self.subTest(command=command):
                for harness in ('codex', 'claude'):
                    self.check(self.event(command), expected, harness)

    def test_node_option_operands_preserve_entry_and_preload_inspection(self):
        self.write('entry.mjs', f'import {{ test }} from "vitest";\nrequire("fs").readFileSync({LIVE!r})\n')
        self.write('safe.cjs', 'console.log("safe")\n')
        value_options = [('-C', 'development'), ('--conditions', 'development'),
                         ('--input-type', 'module'), ('--title', 'title'),
                         ('--inspect-port', '0'), ('--icu-data-dir', '/tmp/icu'),
                         ('--max-old-space-size', '512'), ('--test-name-pattern', 'pattern'),
                         ('--test-reporter', 'spec'), ('--test-shard', '1/2')]
        preload_options = ['-r', '--require', '--import', '--loader', '--experimental-loader', '--test-global-setup']
        for mode, test_mode in [('', False), ('--test --no-test ', False),
                                ('--no-test --test ', True)]:
            for flag, value in value_options + [(flag, 'safe.cjs') for flag in preload_options]:
                for option in (flag + ' ' + value, flag + '=' + value):
                    command = 'node ' + mode + option + ' entry.mjs'
                    with self.subTest(command=command):
                        result = reporters.engine.decide(self.event(command), 'codex')
                        self.assertEqual(result['context']['rule'], SCRIPT)
                        self.assertEqual('vp test run' in result['reason'], test_mode)
        self.write('entry.mjs', 'console.log("safe entry")\n')
        self.write('preload.cjs', f'require("fs").readFileSync({LIVE!r})\n')
        for flag in preload_options:
            for mode in ('', '--test --no-test ', '--check '):
                for option in (flag + ' preload.cjs', flag + '=preload.cjs'):
                    with self.subTest(mode=mode, option=option):
                        self.check(self.event('node ' + mode + option + ' entry.mjs'), SCRIPT)

    def test_node_file_options_inspect_runtime_inputs(self):
        self.write('safe.cjs', 'console.log("safe")\n')
        inputs = [('--env-file', 'hooks.env'), ('--env-file-if-exists', 'hooks.env'),
                  ('--experimental-config-file', 'config.json'),
                  ('--build-snapshot-config', 'config.json'),
                  ('--experimental-package-map', 'config.json'),
                  ('--experimental-sea-config', 'config.json'),
                  ('--openssl-config', 'openssl.cnf'), ('--snapshot-blob', 'snapshot.blob'),
                  ('--localstorage-file', 'storage.json'), ('--test-rerun-failures', 'failures.json')]
        for database in (LIVE, reporters.OPENCODE):
            for flag, name in inputs:
                for body, expected in [('SAFE=1\n', None), ('NODE_OPTIONS=--require ' + database + '\n', SCRIPT)]:
                    self.write(name, body)
                    for mode in ('', '--test --no-test ', '--check '):
                        for option in (flag + ' ' + name, flag + '=' + name):
                            with self.subTest(database=database, flag=flag, mode=mode, expected=expected, option=option):
                                self.check(self.event('node ' + mode + option + ' safe.cjs'), expected)

    def test_listing_exclusions_and_content_readers(self):
        directory = str(Path(LIVE).parent)
        rows = [
            ("rg --files -g '!*statev2*' -g '!*opencode.db*'", None),
            ("find . -name '*.py' -not -name '*statev2*'", None),
            ("find . -name '*statev2*' -print", None),
            ('rg --files ' + LIVE, None), ('ls ' + LIVE, None),
            ("fd 'statev2*' " + directory, None),
            ("fd -g '*.md' " + LIVE, None),
            ('find ' + LIVE + ' -print', None),
            ("find " + directory + " -name 'statev2*' -print", None),
            ('rg somepattern ' + LIVE, READ),
            ('rg pattern -- --files ' + LIVE, READ),
            ('rg -e --files ' + LIVE, READ),
            ('rg --regexp=--files ' + LIVE, READ),
            ('rg --hidden --files ' + LIVE, None),
            ('cat ' + LIVE, READ), ('strings ' + LIVE, READ),
            ("rg -g 'statev2*' somepattern " + directory, READ),
            ("find " + directory + " -name 'statev2*' -exec cat {} +", READ),
            ("fd 'statev2*' " + directory + ' -x cat {}', READ),
            ('rg --files < ' + LIVE, READ),
        ]
        for mode in ('-l', '--files-with-matches', '--files-without-match', '-c', '--count', '--count-matches', '-q', '--quiet', '--json'):
            rows += [('rg --files ' + mode + ' needle ' + LIVE, READ),
                     ('rg ' + mode + ' needle --files ' + LIVE, None)]
        rows += [('rg --files -- ' + LIVE, None),
                 ('rg --files -lc needle ' + LIVE, READ)]
        for binary in ('fd', 'fdfind'):
            for flags in ('-x', '-X', '-Hx', '-HX', '-HIX', '-xcat', '--exec=cat', '--exec-batch=cat'):
                rows.append((binary + ' . ' + flags + ' cat {} ' + LIVE, READ))
            for flags in ('-ejsx', "'-E*x*'", '-C/tmp/example', '--extension jsx', '--exclude=-Hx', '-- -Hx'):
                rows.append((binary + ' . ' + flags + ' ' + LIVE, None))
        for command in ('rg --files --ignore-file ' + LIVE,
                        'fd --ignore-file ' + LIVE,
                        'fd --ignore-file=' + LIVE,
                        'find -files0-from ' + LIVE + ' -print'):
            rows.append((command, READ))
        for prefix in ('RIPGREP_CONFIG_PATH=' + LIVE + ' ',
                       'env RIPGREP_CONFIG_PATH=' + LIVE + ' ',
                       'export RIPGREP_CONFIG_PATH=' + LIVE + '; ',
                       'readonly RIPGREP_CONFIG_PATH=' + LIVE + '; ',
                       'CFG=' + LIVE + '; RIPGREP_CONFIG_PATH="$CFG" '):
            rows.append((prefix + 'rg --files .', READ))
        rows += [('RIPGREP_CONFIG_PATH=/tmp/fixture-ignore rg --files ' + LIVE, None),
                 ('FD_IGNORE=' + LIVE + ' fd .', READ),
                 ('INPUT_LIST=' + LIVE + ' find . -print', READ)]
        for command, expected in rows:
            with self.subTest(command=command):
                self.check(self.event(command), expected)
        with patch.dict(os.environ, {'RIPGREP_CONFIG_PATH': LIVE}):
            self.check(self.event('rg --files .'), READ)
            self.check(self.event('RIPGREP_CONFIG_PATH=/tmp/fixture-ignore rg --files ' + LIVE))

    def test_literal_cd_loop_and_unresolved_directory(self):
        self.write('classify.py', "print('safe')\n")
        for prefix, expected in [
            (f'cd {self.root} && ', None),
            ('cd "$UNKNOWN" && ', UNRESOLVED),
            (f'cd "$UNKNOWN" && (cd {self.root}) && ', UNRESOLVED),
        ]:
            command = prefix + 'for c in a b; do /usr/bin/python3 classify.py --cwd /tmp "$c"; done'
            with self.subTest(prefix=prefix):
                self.check(self.event(command), expected)

    def test_diagnostics_name_reference_and_single_fix(self):
        self.write('x.mjs', f'import {{ test }} from "vitest";\nrequire("fs").readFileSync({LIVE!r})\n')
        result = reporters.engine.decide(self.event('node --test x.mjs'), 'codex')
        reason = result['reason']
        for value in ('this command was NOT run', 'x.mjs:2', LIVE, 'vp test run x.mjs'):
            self.assertIn(value, reason)
        self.assertLessEqual(len(reason.splitlines()), 3)
        self.write('x.mjs', "import { test } from 'vitest'; const example = '/tmp/fixture/statev2.sqlite';\n" + f'require("fs").readFileSync({LIVE!r})\n')
        reason = reporters.engine.decide(self.event('node --test x.mjs'), 'codex')['reason']
        self.assertIn('x.mjs:2', reason)
        self.assertIn(LIVE, reason)
        self.assertNotIn('/tmp/fixture', reason)
        self.write('bootstrap.cjs', 'console.log("safe bootstrap")\n')
        for command, test_mode in [
            ('node --test x.mjs', True), ('node --test -- x.mjs', True),
            ('node --no-warnings --test x.mjs', True),
            ('node -r bootstrap.cjs --test x.mjs', True),
            ('node --test --require bootstrap.cjs x.mjs', True),
            ('node --test --no-test x.mjs', False),
            ('node --no-test --test x.mjs', True),
            ('node --test x.mjs --no-test', True),
            ('node x.mjs --no-test --test', False),
            ('node x.mjs --test', False), ('node -- x.mjs --test', False),
            ('node --test-name-pattern=--test x.mjs', False),
            ('node --test-name-pattern --test x.mjs', False),
        ]:
            with self.subTest(command=command):
                result = reporters.engine.decide(self.event(command), 'codex')
                self.assertEqual(result['context']['rule'], SCRIPT)
                self.assertEqual('vp test run' in result['reason'], test_mode)
        for command, token in [('python3 "$UNKNOWN_SCRIPT"', '$UNKNOWN_SCRIPT'),
                               ('cd "$UNKNOWN" && python3 relative.py', 'relative.py')]:
            result = reporters.engine.decide(self.event(command), 'codex')
            reason = result['reason']
            self.assertIn(token, reason)
            self.assertIn('literal absolute script path', reason)
            self.assertLessEqual(len(reason.splitlines()), 3)
        command = "python3 -c 'import pathlib,sys; pathlib.Path(sys.argv[1]).write_text(sys.argv[2])' /tmp/report.json " + shlex.quote(json.dumps({'reference': LIVE}))
        reason = reporters.engine.decide(self.event(command), 'codex')['reason']
        self.assertIn(LIVE, reason)
        self.assertIn('Use apply_patch to write report data', reason)
        self.assertLessEqual(len(reason.splitlines()), 3)


if __name__ == '__main__':
    unittest.main()

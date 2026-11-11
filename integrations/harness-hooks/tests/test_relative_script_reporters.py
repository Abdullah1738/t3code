"""Reporter inputs are classified, never executed or resolved on old mounts."""
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'src'), str(ROOT / 'tests')]
import claude
import codex
import code_mode_fixture
import engine

LIVE = '/Users/x/.robob/userdata/statev2.sqlite'
OPENCODE = '/Users/x/.local/share/opencode/opencode.db'
FIXTURES = Path(__file__).with_name('fixtures') / 'relative-script'


class RelativeScriptReporterTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        # Only source inspection matters here; do not contact identity services
        # or let the unrelated compute policy reject historical test commands.
        for mock in (
            patch.object(engine, '_native', return_value=(None, None, None)),
            patch.object(engine, '_offbox_mode', return_value='off'),
            patch.object(engine, 'decide_coord', return_value={'decision':'allow', 'reason':'', 'context':{'rule':'no-policy'}}),
            patch.object(engine, '_log'),
            patch.dict(os.environ, {name:'' for name in (engine.COMMAND_IDENTITY_ENV, 'AGENT_GUARD_APPROVED', 'HARNESS_COORD_APPROVED')}),
        ):
            mock.start()
            self.addCleanup(mock.stop)

    def write(self, name, body):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
        return path

    def check(self, event, expected=None, harness='codex'):
        result = engine.decide(event, harness)
        self.assertEqual(result['decision'], 'deny' if expected else 'allow', result)
        if expected:
            self.assertEqual(result['context']['rule'], expected, result)
        else:
            self.assertNotEqual(result['context']['rule'], 'hook-error', result)
        output = io.StringIO()
        adapter = codex if harness == 'codex' else claude
        with patch.object(sys, 'stdin', io.StringIO(json.dumps(event))), patch.object(sys, 'argv', [str(ROOT / 'src' / (harness + '.py'))]), redirect_stdout(output), patch.object(engine, 'decide', wraps=engine.decide) as decide, patch.object(engine, 'log_event_error') as log_error:
            adapter.main()
        decide.assert_called_once_with(event, harness)
        log_error.assert_not_called()
        if expected:
            response = json.loads(output.getvalue())['hookSpecificOutput']
            self.assertEqual(response['permissionDecision'], 'deny')
        else:
            self.assertEqual(output.getvalue(), '')

    def event(self, command, tool='exec_command'):
        return {'hook_event_name':'PreToolUse', 'tool_name':tool, 'cwd':'/unrelated/session/directory',
                'tool_input':{'cmd' if tool == 'exec_command' else 'command':command, 'workdir':str(self.root)}}

    def test_exact_3464_code_mode_call(self):
        fixture = json.loads((FIXTURES / '3464.json').read_text())
        calls = code_mode_fixture.commands(fixture['payload']['input'], fixture['session_cwd'])
        self.assertEqual(len(calls), 1)
        command, cwd = calls[0]
        self.assertEqual(cwd, '/Users/ardud/checkouts/devops-gauge-rule-shape')
        self.assertEqual(fixture['hook_event'], {'hook_event_name':'PreToolUse', 'tool_name':'Bash', 'cwd':cwd, 'tool_input':{'command':command}})
        realpath, path_stat = os.path.realpath, Path.stat
        def historical(path):
            return os.path.abspath(os.fspath(path)).startswith('/Users/ardud/checkouts/')
        def fixture_realpath(path, *args, **kwargs):
            return os.path.abspath(path) if historical(path) else realpath(path, *args, **kwargs)
        def fixture_stat(path, *args, **kwargs):
            if historical(path):
                raise FileNotFoundError(path)
            return path_stat(path, *args, **kwargs)
        with patch.object(os.path, 'realpath', side_effect=fixture_realpath), patch.object(Path, 'stat', autospec=True, side_effect=fixture_stat):
            self.check(fixture['hook_event'])
            for database in (LIVE, OPENCODE):
                twin = command.replace('\nPY\n', f'\nopen({database!r}).read()\nPY\n', 1)
                self.assertNotEqual(twin, command)
                event = {**fixture['hook_event'], 'tool_input':{'command':twin}}
                self.check(event, 'live-database-script')

    def test_retained_reporter_calls_through_both_adapters(self):
        cases = json.loads((FIXTURES / 'reporters.json').read_text())
        cases += json.loads((FIXTURES / 'added-reporters.json').read_text())
        unresolved = {
            # These later calls use variables; #841 owns their resolution.
            'toolu_01HSF5SDthxAE7CbBKJtcbqA': '$SCRIPT_DIR/write_card.py',
            'toolu_01LPn1qyRFv4j2FU9XM3ojgT': '$D/scripts/lib/registry-rtl-consumers.mjs',
            'toolu_01Xp2QFFAsiQnUd25VKtmmyT': '$D/scripts/lib/registry-rtl-consumers.mjs',
            'toolu_01EJVS24gL3YVQkyaDpezY74': '$f',
            'toolu_01BcVNBuxA9GW9DqcBXTJHEj': 'scripts/$t.mjs',
        }
        seen = set()
        # Replaying old commands must not read checkouts that still happen to
        # exist (including unresponsive ovnfs mounts). Disk-source checks below
        # separately prove inspection against controlled, real script files.
        with patch.object(os.path, 'realpath', side_effect=lambda path, *a, **kw: os.path.abspath(path)), patch.object(Path, 'stat', side_effect=FileNotFoundError):
            for case in cases:
                for call in case['commands']:
                    command, cwd = call['cmd'], call['workdir']
                    self.assertEqual(hashlib.sha256(command.encode()).hexdigest(), call['sha256'])
                    if case['tool_name'] == 'exec':
                        if 'decode_error' in case:
                            # TorSSH #38's dynamic load loop exceeds this
                            # fixture decoder's grammar. Its command is
                            # retained verbatim in the hook refusal output.
                            self.assertEqual(case['call_id'], 'call_1a3c925565fb4679950baf5cd6bdedb6')
                            with self.assertRaises(code_mode_fixture.Unresolved):
                                code_mode_fixture.commands(case['input'], case['session_cwd'])
                            self.assertIn(json.dumps(cwd), case['input'])
                        else:
                            decoded = code_mode_fixture.commands(case.get('decoded_input', case['input']), case['session_cwd'])
                            self.assertIn((command, cwd), decoded)
                    else:
                        self.assertEqual(case['input']['command'], command)
                    expected = 'live-database-script-unresolved' if case['call_id'] in unresolved else None
                    for harness in ('codex', 'claude'):
                        event = {'hook_event_name':'PreToolUse', 'tool_name':'Bash', 'cwd':cwd, 'tool_input':{'command':command}}
                        with self.subTest(reporter=case['reporter_id'], call=case['call_id'], harness=harness):
                            self.check(event, expected, harness)
                            if expected:
                                result = engine.decide(event, harness)
                                self.assertIn(unresolved[case['call_id']], result['reason'])
                                seen.add(case['call_id'])
        self.assertEqual(seen, set(unresolved))

    def test_existing_scripts_resolve_against_workdir_and_flags(self):
        self.write('tmp/task.py', "print('ok')")
        self.write('scripts/check.mjs', "console.log('ok')")
        self.write('run.sh', 'echo ok')
        invocations = [
            'python3 tmp/task.py', 'python3 -I tmp/task.py', 'python3 -u -B tmp/task.py',
            'offbox run -- python3 tmp/task.py', 'uv run python tmp/task.py',
            'node --test scripts/check.mjs', "node --test --test-name-pattern='a|b' scripts/check.mjs",
            'offbox run --bg -- bash run.sh', 'FLAG=8 bash run.sh --key "$(cat tmp/public.pub)"',
            'python3 ' + str(self.root / 'tmp/task.py'),
        ]
        for command in invocations:
            for harness, tool in [('codex','exec_command'), ('codex','Bash'), ('claude','Bash')]:
                with self.subTest(command=command, harness=harness):
                    self.check(self.event(command, tool), harness=harness)
        for database in (LIVE, OPENCODE):
            self.write('tmp/task.py', f'open({database!r}).read()')
            self.write('scripts/check.mjs', f'require("fs").readFileSync({database!r})')
            self.write('run.sh', 'sqlite3 ' + database + ' .tables')
            for command in invocations:
                with self.subTest(command=command, database=database):
                    self.check(self.event(command), 'live-database-script')

    def test_create_run_and_syntax_only_shapes(self):
        rows = [
            ('tmp/quint/3464/fix_rules.py', 'for r in []:\n pass\n', 'python3 tmp/quint/3464/fix_rules.py', 'python3'),
            ('tmp/implement.py', "text = 'node scripts/absent.mjs'\n", 'offbox run -- python3 tmp/implement.py', 'python3'),
            ('tmp/followup.cjs', "console.log('ok')\n", 'offbox run -- node ./tmp/followup.cjs', 'node'),
            ('tmp/acceptance.sh', './configure\n"$CC" $CFLAGS\nsh docker/fetch-foundationdb.sh\n', 'offbox run --bg -- bash tmp/acceptance.sh', 'bash'),
            ('tmp/validate.sh', 'node scripts/check.mjs\noffbox run -- ./scripts/check.sh\n', 'bash -n tmp/validate.sh', 'bash'),
            ('tmp/REPORT.md', '```sh\npython3 tmp/absent.py\nuv run python tmp/b1/missing.py\n./scripts/check.sh\n```\n', '', 'bash'),
        ]
        for name, body, invocation, interpreter in rows:
            for database in (LIVE, OPENCODE):
                with self.subTest(name=name, invocation=invocation, database=database):
                    command = f"cat > {name} <<'EOF'\n{body}EOF\n{invocation}"
                    self.check(self.event(command))
                    read = f'open({database!r}).read()' if interpreter == 'python3' else f'require("fs").readFileSync({database!r})' if interpreter == 'node' else 'sqlite3 ' + database + ' .tables'
                    twin = command.replace('\nEOF', '\n' + read + '\nEOF', 1)
                    if not invocation or ' -n ' in invocation:
                        # Merely saving a command, or parsing it with bash -n,
                        # does not execute it. Running that same file must deny.
                        self.check(self.event(twin))
                        twin += f'\n{interpreter} {name}'
                    self.check(self.event(twin), 'live-database-script')

    def test_inline_python_prose_compound_and_loop_shapes(self):
        prose = "from pathlib import Path\ntext = '''python3 tmp/missing.py\nnode --test scripts/missing.mjs\nbash tmp/fdb-setup.sh\n'''\nPath('tmp/FACTS.md').write_text(text)\n"
        self.write('tmp/audit.py', "print('ok')")
        self.write('scripts/test.mjs', "console.log('ok')")
        inline = "python3 - <<'PY'\n" + prose + 'PY\n'
        rows = [inline, inline.replace('python3 -', 'python3'), inline.replace('python3 -', '/usr/bin/python3 -'),
                inline + f'python3 {self.root}/tmp/audit.py\nnode --test scripts/test.mjs\ngit diff --check',
                'if git merge branch; then :; else rc=$?; fi\n' + inline + 'node --test scripts/test.mjs',
                f'cd {self.root} && for n in a b; do node scripts/test.mjs events "$n"; done']
        for command in rows:
            with self.subTest(command=command):
                for harness, tool in [('codex','Bash'), ('codex','exec_command'), ('claude','Bash')]:
                    self.check(self.event(command, tool), harness=harness)
                for database in (LIVE, OPENCODE):
                    if '\nPY\n' in command:
                        twin = command.replace('\nPY\n', f'\nopen({database!r}).read()\nPY\n', 1)
                        self.check(self.event(twin), 'live-database-read')
                    else:
                        self.write('scripts/test.mjs', f'require("fs").readFileSync({database!r})')
                        self.check(self.event(command), 'live-database-script')
                        self.write('scripts/test.mjs', "console.log('ok')")

    def test_unresolved_script_names_the_word_and_fix(self):
        event = self.event('python3 "$UNKNOWN_SCRIPT"')
        self.check(event, 'live-database-script-unresolved')
        result = engine.decide(event, 'codex')
        for text in ('$UNKNOWN_SCRIPT', str(self.root), 'literal path', 'split the steps'):
            self.assertIn(text, result['reason'])

    def test_interpreter_stdin_data_and_executed_controls(self):
        body = "from pathlib import Path\nPath('tmp/REPORT.md').write_text('''node --test scripts/test-better-stack-alert-evaluator.mjs\npython3 -m unittest terraform/check.py\npython3 tmp/cards/169/verify-downloads.py''')\n"
        self.check(self.event("python3 <<'PY'\n" + body + 'PY'))
        for database in (LIVE, OPENCODE, str(Path.home() / '.t3/userdata/statev2.sqlite')):
            self.check(self.event("python3 <<'PY'\n" + body + f'open({database!r}).read()\nPY'), 'live-database-read')
        for command in ('python3 "$X/gate.py"', "bash <<'EOF'\npython3 \"$X/gate.py\"\nEOF"):
            self.check(self.event(command), 'live-database-script-unresolved')
        self.check(self.event(f"bash <<'EOF'\npython3 -c \"open('{LIVE}').read()\"\nEOF"), 'live-database-read')

    def test_legacy_home_database_and_workspace_copies(self):
        home = str(Path.home())
        for prefix in (home, '~', '$HOME', '${HOME}'):
            for suffix in ('statev2.sqlite', 'statev2.sqlite-wal', 'statev2.sqlite-shm'):
                path = prefix + '/.t3/userdata/' + suffix
                with self.subTest(path=path):
                    self.check(self.event('cat ' + path), 'live-database-read')
                    self.check(self.event("python3 <<'PY'\nopen(" + repr(path) + ").read()\nPY"), 'live-database-read')
        for path in (self.root / '.t3/userdata/statev2.sqlite', self.root / 'fixture/userdata/statev2.sqlite'):
            self.check(self.event(f"python3 <<'PY'\nopen({str(path)!r}).read()\nPY"))

    def test_added_stdin_inputs_and_live_twins(self):
        cases = json.loads((FIXTURES / 'added-reporters.json').read_text())
        self.assertEqual({case['reporter_id'] for case in cases}, {'usdtwallet-169', 'crpko-3314', 'torssh-37'})
        for case in cases:
            for call in case['commands']:
                event = {'hook_event_name':'PreToolUse', 'tool_name':'Bash', 'cwd':call['workdir'], 'tool_input':{'command':call['cmd']}}
                with self.subTest(reporter=case['reporter_id']):
                    self.check(event)
                    for database in (LIVE, OPENCODE, str(Path.home() / '.t3/userdata/statev2.sqlite')):
                        twin = call['cmd'].replace('\nPY', f'\nopen({database!r}).read()\nPY', 1)
                        self.assertNotEqual(twin, call['cmd'])
                        self.check({**event, 'tool_input':{'command':twin}}, 'live-database-read')

    def test_3226_json_data_writer_body(self):
        body = (FIXTURES / '3226-update-facts.py').read_text()
        event = {'hook_event_name':'PreToolUse', 'tool_name':'Bash',
                 'cwd':'/Volumes/ExternalSSD/crpko-devops/tmp/card-3226/repo',
                 'tool_input':{'command':"python3 <<'PY'\n" + body + '\nPY'}}
        self.check(event)
        for database in (LIVE, OPENCODE):
            self.check({**event, 'tool_input':{'command':event['tool_input']['command'].replace('\nPY', f'\nopen({database!r}).read()\nPY')}}, 'live-database-read')


if __name__ == '__main__':
    unittest.main()

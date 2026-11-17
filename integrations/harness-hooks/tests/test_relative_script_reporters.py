"""Reporter inputs are classified, never executed or resolved on old mounts."""
if __package__:
    from . import test_environment
else:
    import test_environment

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
import isolated_source_cases

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
            isolated_source_cases.fixture_environment_patch(),
            patch.object(engine, '_native', return_value=(None, None, None)),
            patch.object(engine, '_offbox_mode', return_value='off'),
            patch.object(engine, '_log'),
            patch.dict(os.environ, {name:'' for name in (engine.COMMAND_IDENTITY_ENV,)}),
            patch.dict(os.environ, {'PATH': os.pathsep.join(('/usr/bin', '/bin', os.environ['PATH']))}),
        ):
            mock.start()
            self.addCleanup(mock.stop)
        tool = isolated_source_cases.trusted_node_environment()
        tool.__enter__()
        self.addCleanup(tool.__exit__, None, None, None)

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

    def test_isolated_source_reporters_through_native_hook_entry_points(self):
        fixtures = sorted((FIXTURES.parent / 'isolated-source').glob('*.json'))
        with patch.object(os.path, 'realpath', side_effect=lambda p, *a, **kw: os.path.abspath(p)), patch.object(Path, 'stat', side_effect=FileNotFoundError):
            for file in fixtures:
                row = json.loads(file.read_text())
                if row['payload']['name'] == 'exec':
                    decoded = code_mode_fixture.commands(row['payload']['input'], row['session_cwd'])
                    for call_index, call in enumerate(row['commands']):
                        self.assertIn((call['cmd'], call['workdir']), decoded)
                for call_index, call in enumerate(row['commands']):
                    self.assertEqual(hashlib.sha256(call['cmd'].encode()).hexdigest(), call['sha256'])
                    cwd = call['workdir'] or row['session_cwd']
                    # The Codex runtime invokes the native hook as Bash.command;
                    # the exec_command shape also proves workdir beats cwd.
                    for harness, tool in [('codex', 'Bash'), ('codex', 'exec_command'), ('claude', 'Bash')]:
                        event = {'hook_event_name':'PreToolUse', 'tool_name':tool, 'cwd':cwd,
                                 'tool_input':{'cmd' if tool == 'exec_command' else 'command':call['cmd']}}
                        if tool == 'exec_command':
                            event['cwd'] = '/unrelated/session/directory'
                            event['tool_input']['workdir'] = cwd
                        with self.subTest(fixture=file.name, harness=harness, tool=tool):
                            expected = 'live-database-script-unresolved' if (file.name in {'s-03.json', 's-04.json', 'o-00.json', 'o-01.json'} or file.name == 't-07.json' and call_index == 1) else None
                            self.check(event, expected, harness)
                            # Independent real executed statement after inert
                            # data must still be checked by every adapter.
                            key = 'cmd' if tool == 'exec_command' else 'command'
                            event['tool_input'][key] += '\npython3 -c ' + repr(f'open({LIVE!r}).read()')
                            self.check(event, expected or 'live-database-read', harness)

    def test_isolated_migration_and_heredoc_controls_through_hook(self):
        isolated_source_cases.write_migration_helpers(self.root)
        source = ROOT.parents[1] / 'apps/server/scripts/migrate-dev-db.ts'
        self.write('apps/server/scripts/migrate-dev-db.ts', source.read_text())
        self.write('package.json', json.dumps({'scripts':{'migrate-dev-db':'node apps/server/scripts/migrate-dev-db.ts'}}))
        (self.root / 'link.sqlite').symlink_to(Path.home() / '.robob/userdata/statev2.sqlite')
        for label, command, expected in isolated_source_cases.cases(self.root):
            for harness, tool in [('codex', 'exec_command'), ('claude', 'Bash')]:
                with self.subTest(case=label, command=command, harness=harness):
                    self.check(self.event(command, tool), expected, harness)

    def test_mktemp_shell_fixture_and_near_misses_through_hooks(self):
        source = ROOT.parents[1] / 'integrations/memory-system/tests/test_backup_replica.sh'
        self.write('integrations/memory-system/tests/test_backup_replica.sh', source.read_text())
        for harness in ('codex', 'claude'):
            for command in ('bash integrations/memory-system/tests/test_backup_replica.sh',
                            '/bin/bash ' + str(self.root / 'integrations/memory-system/tests/test_backup_replica.sh')):
                self.check(self.event(command), harness=harness)
                with patch.dict(os.environ, {'BASH_FUNC_mktemp%%': '() { echo "$HOME"; }'}):
                    self.check(self.event(command), 'live-database-script', harness)
            for source, expected in isolated_source_cases.mktemp_scripts():
                self.write('tmp/fixture.sh', source)
                with self.subTest(source=source, harness=harness):
                    self.check(self.event('bash tmp/fixture.sh'), expected, harness)

    def test_fixture_tool_identity_through_native_hooks(self):
        source = ROOT.parents[1] / 'integrations/memory-system/tests/test_backup_replica.sh'
        self.write('tmp/backup.sh', source.read_text())
        for label, source, search_path, expected, shell in isolated_source_cases.fixture_tool_cases(self.root):
            self.write('tmp/fixture.sh', source)
            commands = [shell + ' tmp/fixture.sh']
            if label.startswith('path-'):
                commands.append(shell + ' tmp/backup.sh')
            for harness, tool in [('codex', 'exec_command'), ('codex', 'Bash'), ('claude', 'Bash')]:
                for command in commands:
                    with self.subTest(case=label, path=search_path, harness=harness, tool=tool), patch.dict(os.environ, {'PATH':search_path}):
                        self.check(self.event(command, tool), expected, harness)

    def test_backup_command_shapes_and_edited_copies_through_hooks(self):
        source = ROOT.parents[1] / 'integrations/memory-system/tests/test_backup_replica.sh'
        commands, variants = isolated_source_cases.backup_cases(self.root, source.read_text())
        self.write('sibling.sh', 'cat ~/.t3/userdata/statev2.sqlite')
        for variant, body, expected in variants:
            self.write('integrations/memory-system/tests/test_backup_replica.sh', body)
            for shape, command, cwd in commands:
                for harness, tool in [('claude', 'Bash'), ('codex', 'Bash'), ('codex', 'exec_command')]:
                    with self.subTest(variant=variant, shape=shape, harness=harness, tool=tool):
                        event = self.event(command, tool)
                        event['tool_input']['workdir'] = str(cwd)
                        self.check(event, expected, harness)

    def test_fixture_and_migration_review_corpus_through_hooks(self):
        isolated_source_cases.write_migration_helpers(self.root)
        backup = ROOT.parents[1] / 'integrations/memory-system/tests/test_backup_replica.sh'
        migrate = ROOT.parents[1] / 'apps/server/scripts/migrate-dev-db.ts'
        rows = [('tmp/fixture.sh', 'bash tmp/fixture.sh', row) for row in isolated_source_cases.setup_control_cases(backup.read_text())]
        rows += [('apps/server/scripts/migrate-dev-db.ts', 'node apps/server/scripts/migrate-dev-db.ts --source /tmp/copy.sqlite --base-dir /tmp/dev-home', row) for row in isolated_source_cases.migration_mutations(migrate.read_text())]
        for path, command, (label, body, expected) in rows:
            self.write(path, body)
            prefixes = ('', 'offbox run -- ', 'offbox run --remote --no-fallback -- ') if label.startswith('sqlite-input-') else ('',)
            for prefix in prefixes:
                for harness, tool in [('claude', 'Bash'), ('codex', 'Bash'), ('codex', 'exec_command')]:
                    with self.subTest(case=label, prefix=prefix, harness=harness, tool=tool):
                        self.check(self.event(prefix + command, tool), expected, harness)
        self.write('tmp/fixture.sh', backup.read_text())
        for destination in (LIVE, '~/.t3/userdata/statev2.sqlite', '$HOME/.robob/userdata/statev2.sqlite'):
            for harness, tool in [('claude', 'Bash'), ('codex', 'Bash'), ('codex', 'exec_command')]:
                with self.subTest(destination=destination, harness=harness, tool=tool):
                    self.check(self.event('bash tmp/fixture.sh > ' + destination + ' 2>&1', tool), 'live-database-script', harness)

    def test_fixture_startup_environment_through_hooks(self):
        backup = ROOT.parents[1] / 'integrations/memory-system/tests/test_backup_replica.sh'
        self.write('tmp/fixture.sh', backup.read_text())
        for name in ('BASH_ENV', 'ENV', 'BASHOPTS', 'SHELLOPTS', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONWARNINGS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'):
            for harness, tool in [('claude', 'Bash'), ('codex', 'Bash'), ('codex', 'exec_command')]:
                with self.subTest(startup=name, harness=harness, tool=tool):
                    self.check(self.event(name + '=/tmp/unproved-helper bash tmp/fixture.sh', tool), 'live-database-script', harness)
                    with patch.dict(os.environ, {name: '/tmp/unproved-helper'}):
                        self.check(self.event('bash tmp/fixture.sh', tool), 'live-database-script', harness)

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
            self.check(fixture['hook_event'], 'live-database-script-unresolved')
            for database in (LIVE, OPENCODE):
                twin = command.replace('\nPY\n', f'\nopen({database!r}).read()\nPY\n', 1)
                self.assertNotEqual(twin, command)
                event = {**fixture['hook_event'], 'tool_input':{'command':twin}}
                self.check(event, 'live-database-script-unresolved')

    def test_retained_reporter_calls_through_both_adapters(self):
        cases = json.loads((FIXTURES / 'reporters.json').read_text())
        cases += json.loads((FIXTURES / 'added-reporters.json').read_text())
        unresolved = {
            'toolu_019XRY6Gvz9Gtm2htPdzT6qa': 'executable provenance or mutation proof failed',
            'call_397846cad4494f52b0e9c57a3f85cd7a': 'executable provenance or mutation proof failed',
            'call_0c82499091334bff8b9eb8a8ed73bcbf': 'python: non-isolated startup',
            'call_c3593fb888e64c9f8f808246c766402a': 'python: non-isolated startup',
            'call_c2ba5fc029614e1da361649017985d81': 'python: non-isolated startup',
            'call_eb023391ca2d4507b811e7a5b6519cb2': 'python: non-isolated startup',
            'call_3c100fa581a24b9098a56b2236a87e44': 'command wrapper proof failed',
            'call_f47459aeb9274a549935ac297a7af33f': 'python: non-isolated startup',
            'call_dbaae78364c64a4cbcc003d103da0884': 'python: non-isolated startup',
            'call_cb019549a9334bf29225f9aa9504e297': 'command wrapper proof failed',
            'call_bb309dbe7c3e4ae68be5c42f9aca3bdb': 'python: non-isolated startup',
            'call_a7f9cb33e7a3402895dd0732a98f6f41': 'python: non-isolated startup',
            'call_93af2fcd2c7141df8a27c123f19e5dbc': 'python: non-isolated startup',
            'call_905a54920e644004a50704b6a64c89dc': 'python: non-isolated startup',
            'call_8d27799cb10d469aaed2f4e0b75b1424': 'python: non-isolated startup',
            'call_7211522c68dc4cfd9b7a03fd40029981': 'python: non-isolated startup',
            'call_61f72d3d774e4f1e9c7c3401a85e481e': 'python: non-isolated startup',
            'call_5e4c0612c07448d6aea87d0fe9a55490': 'python: non-isolated startup',
            'call_59ff6368a1b44669815d756abdc84f0e': 'python: non-isolated startup',
            'call_582da943ca854989821aa5605fe0054b': 'python: non-isolated startup',
            'call_55c5d86ec5f44e27b37fb0ff319eac54': 'python: non-isolated startup',
            'call_52d93f07d49044ef882f9add81a10542': 'python: non-isolated startup',
            'call_4f03bb1ff4844c5ba2df34cc593cf77a': 'command wrapper proof failed',
            'call_45eff52bf94242cd80a3025ccaca3323': 'python: non-isolated startup',
            'call_3be4afa481b74700ab1cf31ecdbc0f08': 'python: non-isolated startup',
            'call_3b7b316ae8a84badb82d8037a79f0553': 'python: non-isolated startup',
            'call_35b6d8c7de6b42fb866df232a5ba3bc1': 'python: non-isolated startup',
            'call_327d4b73a5654b299c79001ba428fb4f': 'python: non-isolated startup',
            'call_22a98a2ba5ba4939b62dbdcfa08d3c40': 'python: non-isolated startup',
            'call_22157186d164452881bbe2b06f2c929f': 'python: non-isolated startup',
            'call_1f7e696081364ba58aeb494a3c2d4bf8': 'python: non-isolated startup',
            'call_16e99fd17f1d499caed7880daf547305': 'python: non-isolated startup',
            'call_1563736b302d4a4098b10921ef0c258a': 'python: non-isolated startup',
            'call_14650ff2f13743bb967f611aada87e40': 'python: non-isolated startup',
            'call_13e81ad91ccf4b7988679787560aadb6': 'python: non-isolated startup',
            'call_118f05114b044489a11ca8ef534c4d14': 'python: non-isolated startup',
            'call_09f2adc408a64b049b38c8e5cf2bb356': 'python: non-isolated startup',
            # Dynamic paths without a matching source proof stay unresolved.
            'toolu_01LPn1qyRFv4j2FU9XM3ojgT': '$D/scripts/lib/registry-rtl-consumers.mjs',
            'toolu_01Xp2QFFAsiQnUd25VKtmmyT': '$D/scripts/lib/registry-rtl-consumers.mjs',
            'toolu_01EJVS24gL3YVQkyaDpezY74': '$f',
            'call_363a7f31bc384aab9c301cdb910617c2': 'python: non-isolated startup',
            # These writers follow unproved commands or unsupported brace words.
            'call_88af2f048e124c41adcd9a9b768cddd7': 'heredoc writer',
            'call_8e1318de1e854e688a15d7312d85fcd1': 'heredoc writer',
            'call_faa5d79b00b34bacba6060455445ed12': 'heredoc writer',
            'call_cab9209449084c8e97ebeffb3b3d8fce': 'brace expansion',
            'call_465eeb8f3a754d0ea843010a5d079ab9': 'brace expansion',
            'call_68b71b26bd4040ad9f01469397760615': 'python: non-isolated startup',
            'call_d95383413b6242489793635991b4946c': 'heredoc writer',
            'call_0c02a91a69684e0787a4ed63e50287f2': 'heredoc writer',
            'call_3eddb5bf6400468fbeec2a7cb065719a': 'heredoc writer',
            'call_9102f1f55ad34d189446c670febbd584': 'heredoc writer',
            'call_851993aaf0254922bf6070f859d45aad': 'heredoc writer',
            # Parse-only exits also require executable history. These calls
            # first run non-isolated Python or another unproved mutator.
            'call_50f52d145b4c4d2c9d2023bb8da7a789': 'execution parse-only',
            'call_7477033acf254d04a969eb0e89ed5de6': 'execution parse-only',
            'call_a8bbc8750b6745288668da2b1ec0c7b5': 'execution parse-only',
            'call_a858f338866745a3a7bcb7567b532d03': 'execution parse-only',
            'call_8090a0cc8647424d8af13d1f66cb731f': 'python: non-isolated startup',
            'call_92000a57597c4676b7491c07cbbb8994': 'execution parse-only',
            'call_3f74b20266f541e0ada057e36dbaa07b': 'execution parse-only',
            'call_595838d98a5a4eedab18d4c6a71aefe8': 'execution parse-only',
            'call_e2717c195e8a4f70883e426e4c88174a': 'execution parse-only',
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
                    expected = 'live-database-script-unresolved' if name in {'tmp/quint/3464/fix_rules.py', 'tmp/implement.py', 'tmp/followup.cjs', 'tmp/acceptance.sh'} else None
                    self.check(self.event(command), expected)
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
        for text in ('$UNKNOWN_SCRIPT', str(self.root), 'literal absolute script path'):
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

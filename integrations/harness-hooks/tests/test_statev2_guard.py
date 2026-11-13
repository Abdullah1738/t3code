import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import engine
import statev2_guard as guard
import code_mode_fixture
import isolated_source_cases

LIVE = "/Users/x/.robob/userdata/statev2.sqlite"
READ = "live-database-read"
SCRIPT = "live-database-script"
UNRESOLVED = "live-database-script-unresolved"


class GuardTests(unittest.TestCase):
    def setUp(self):
        clean = isolated_source_cases.fixture_environment_patch()
        clean.start()
        self.addCleanup(clean.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        realpath, path_stat = os.path.realpath, Path.stat
        # Historical reporter paths must not depend on mounted checkouts.
        # Retained script bodies are checked separately in temporary directories.
        def frozen_path(path):
            return os.path.abspath(os.fspath(path)).startswith("/Users/ardud/checkouts/")
        def fixture_realpath(path, *args, **kwargs):
            return os.path.abspath(path) if frozen_path(path) else realpath(path, *args, **kwargs)
        def fixture_stat(path, *args, **kwargs):
            if frozen_path(path):
                raise FileNotFoundError(path)
            return path_stat(path, *args, **kwargs)
        for mock in (patch.object(os.path, "realpath", side_effect=fixture_realpath), patch.object(Path, "stat", autospec=True, side_effect=fixture_stat)):
            mock.start()
            self.addCleanup(mock.stop)
        (self.root / "tmp").mkdir()
        self.write("tmp/t.py", "print('ok')")
        self.write("tmp/live.py", f"open({LIVE!r}, 'rb').read()")

    def write(self, name, source):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source)
        return path

    def classify(self, command):
        return guard.classify(command, str(self.root))

    def table(self, rows):
        for command, expected in rows:
            with self.subTest(command=command):
                self.assertEqual(self.classify(command), expected)

    def test_heredoc_delimiters_follow_shell_quote_removal(self):
        rows = [
            (r'\EOF', 'EOF', True),
            (r'\"EOF\"', '"EOF"', True),
            ('E"O"F', 'EOF', True),
            ("'E'OF", 'EOF', True),
            ('EOF', 'EOF', False),
            ('"E\\OF"', r'E\OF', True),
            ('"E\\$OF"', 'E$OF', True),
            ('"E\\`OF"', 'E`OF', True),
            ('"E\\\\OF"', r'E\OF', True),
            ('"E\\\"OF"', 'E"OF', True),
            ('E\\\nOF', 'EOF', False),
            ('"E\\\nOF"', 'EOF', True),
            ("''", '', True),
        ]
        for raw, delimiter, quoted in rows:
            with self.subTest(raw=raw):
                command = 'cat <<' + raw + '\nhi\n' + delimiter + '\n'
                shell, bodies = guard._heredocs(command)
                self.assertEqual(bodies, {'__guard_heredoc_0__': ('hi\n', quoted)})
                self.assertIn('<< __guard_heredoc_0__', shell)
                # Compare the delimiter with the shell without running fixture payloads.
                result = subprocess.run(['/bin/bash', '--noprofile', '--norc'], input=command,
                                        text=True, capture_output=True, check=True)
                self.assertEqual((result.stdout, result.stderr), ('hi\n', ''))
        self.assertEqual(guard._heredocs('cat <<-\\EOF\n\thi\n\tEOF\n')[1],
                         {'__guard_heredoc_0__': ('hi\n', True)})
        for raw in ['"EOF', "E'OF", 'E"OF']:
            with self.subTest(raw=raw):
                with self.assertRaises(guard.AmbiguousScript) as error:
                    guard._heredocs('cat <<' + raw + '\n')
                self.assertIn(repr(raw), str(error.exception))
        with self.assertRaises(guard.AmbiguousScript):
            guard._heredocs('cat <<\\EOF\nhi\nMISSING\n')
        with self.assertRaises(guard.AmbiguousScript):
            guard._heredocs('cat <<\\"EOF\\"\nhi\nEOF\n')

    def test_wrapped_heredoc_reporters(self):
        fixtures = Path(__file__).with_name('fixtures') / 'heredoc-delims'
        for name in ['robob-1182-bash-c.sh', 'robob-639-offbox.sh']:
            with self.subTest(reporter=name):
                self.assertEqual(guard.classify_detail((fixtures / name).read_text(), str(self.root)),
                                 (None, None))
        minimal = "node --input-type=module <<'NODE'\nconsole.log(1)\nNODE\n"
        self.assertEqual(guard.classify_detail('offbox run -- ' + shlex.quote(minimal), str(self.root)),
                         (None, None))

    def test_heredocs_unwrap_before_parsing_and_still_check_bodies(self):
        wrappers = [
            lambda payload: 'offbox run -- ' + shlex.quote(payload),
            lambda payload: 'bash -c ' + shlex.quote(payload),
            lambda payload: 'bash -c "' + payload.replace('\\', '\\\\').replace('"', '\\"').replace('$', '\\$').replace('`', '\\`') + '"',
            lambda payload: 'ssh box ' + shlex.quote(payload),
            lambda payload: 'python3 /abs/offbox.py ssh box bash -c "' + payload.replace('"', '\\"') + '"',
        ]
        for wrapper in wrappers:
            for raw in ['EOF', r'\EOF', 'E"O"F', "'E'OF"]:
                with self.subTest(wrapper=wrapper, delimiter=raw):
                    safe = 'bash <<' + raw + '\necho hi\nEOF\n'
                    self.assertIsNone(self.classify(wrapper(safe)))
                    self.assertEqual(self.classify(wrapper(safe.replace('echo hi', 'sqlite3 ' + LIVE))), READ)
            for payload in ['bash <<"EOF\necho hi\nEOF\n', 'bash <<EOF\necho hi\n']:
                with self.subTest(wrapper=wrapper, payload=payload):
                    self.assertEqual(self.classify(wrapper(payload)), UNRESOLVED)
        self.table([
            ('bash <<EOF\nsqlite3 ' + LIVE + '\nEOF\n', READ),
            ('cat <<EOF\n$(sqlite3 ' + LIVE + ')\nEOF\n', READ),
            ('cat <<E"O"F\n$(sqlite3 ' + LIVE + ')\nEOF\n', None),
            ('cat <<E\\\nOF\n$(sqlite3 ' + LIVE + ')\nEOF\n', READ),
            ('bash <<E"O"F\nsqlite3 ' + LIVE + '\nEOF\n', READ),
            ("offbox run -- bash <<'EOF'\nsqlite3 " + LIVE + '\nEOF\n', READ),
        ])

    def test_stdin_argv_reporter_regressions(self):
        for arg in ['"$results_dir"', '"$task_pr_dir/body.md"']:
            command = "results_dir=$(mktemp -d)\npython3 -I - " + arg + " <<'PY'\nimport sys; print(sys.argv[1])\nPY\n"
            self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))
        self.assertIsNone(self.classify('bash -s "$x" <<\'SH\'\necho hi\nSH\n'))
        self.assertEqual(self.classify('python3 -I - "$x" <<\'PY\'\nimport sqlite3; sqlite3.connect(' + repr(LIVE) + ')\nPY\n'), READ)

    def test_remote_payloads_cannot_replace_caller_proofs(self):
        wrappers = [
            ('offbox', lambda text: 'offbox run -- ' + shlex.quote(text)),
            ('offbox argv', lambda text: 'offbox run -- bash -c ' + shlex.quote(text)),
            ('offbox stdin', lambda text: "offbox run -- bash <<'REMOTE'\n" + text + '\nREMOTE\n'),
            ('ssh', lambda text: 'ssh box ' + shlex.quote(text)),
            ('python ssh', lambda text: 'python3 /abs/offbox.py ssh box ' + shlex.quote(text)),
            ('nested shell', lambda text: 'offbox run -- ' + shlex.quote('bash -c ' + shlex.quote(text))),
        ]
        for name, wrapper in wrappers:
            for payload in ['cd /', "cat > tmp/live.py <<'EOF'\nprint(1)\nEOF\n",
                            'S=tmp/t.py']:
                with self.subTest(wrapper=name, payload=payload):
                    self.assertEqual(self.classify('S=tmp/live.py; ' + wrapper(payload) + '; python3 "$S"'), SCRIPT)
                    self.assertEqual(self.classify(wrapper(payload) + '; python3 tmp/live.py'), SCRIPT)
                    self.assertIsNone(self.classify(wrapper(payload) + '; python3 tmp/t.py'))
            self.assertEqual(self.classify(wrapper('python3 tmp/live.py')), SCRIPT)
            self.assertEqual(self.classify("cat > tmp/p.py <<'EOF'\nopen(" + repr(LIVE) + ").read()\nEOF\n" + wrapper('python3 tmp/p.py')), SCRIPT)
        self.assertEqual(self.classify("cat > tmp/p.py <<'EOF'\nprint(1)\nEOF\noffbox run -- 'echo hi' > tmp/p.py\npython3 tmp/p.py"), UNRESOLVED)
        self.assertEqual(self.classify('offbox run -- cd /; python3 tmp/live.py'), SCRIPT)

    def test_remote_argv_preserves_caller_expansion(self):
        self.write('safe.py', 'print(1)')
        self.write('with space/safe.py', 'print(1)')
        self.write('safe__suffix__.py', 'print(1)')
        rows = [
            ('quoted reader', 'DB=' + LIVE, 'cat "$DB"', READ),
            ('braced reader', 'DB=' + LIVE, 'cat "${DB}"', READ),
            ('bare reader', 'DB=' + LIVE, 'cat $DB', READ),
            ('reader suffix', 'D=/Users/x/.robob/userdata', 'cat "$D"/statev2.sqlite', READ),
            ('conditional reader', 'DB=' + LIVE + '; if true; then DB=tmp/t.py; fi', 'cat "$DB"', READ),
            ('quoted script', 'S=safe.py', 'python3 "$S"', None),
            ('braced script', 'S=safe.py', 'python3 "${S}"', None),
            ('bare script', 'S=safe.py', 'python3 $S', None),
            ('script suffix', 'D=tmp', 'python3 "$D"/t.py', None),
            ('live script', 'S=tmp/live.py', 'python3 "$S"', SCRIPT),
            ('unknown script', '', 'python3 "$UNKNOWN"', UNRESOLVED),
            ('conditional script', 'S=tmp/live.py; if true; then S=safe.py; fi', 'python3 "$S"', SCRIPT),
            ('double-quoted prefix', 'S=tmp/li; Sve=tmp/t', 'python3 "$S"ve.py', SCRIPT),
            ('single-quoted suffix', 'S=tmp/li; Sve=tmp/t', 'python3 $S\'ve.py\'', SCRIPT),
            ('double-quoted suffix', 'S=tmp/li; Sve=tmp/t', 'python3 $S"ve.py"', SCRIPT),
            ('escaped suffix', 'S=tmp/li; Sve=tmp/t', r'python3 $S\ve.py', SCRIPT),
            ('home reader', '', 'cat "$HOME/.t3/userdata/statev2.sqlite"', READ),
            ('braced home reader', '', 'cat "${HOME}/.t3/userdata/statev2.sqlite"', READ),
            ('pwd live script', '', 'python3 "$PWD/tmp/live.py"', SCRIPT),
            ('pwd safe script', '', 'python3 "${PWD}/safe.py"', None),
        ]
        for wrapper in ['offbox run -- ', 'ssh box ', 'python3 /abs/offbox.py ssh box ']:
            for label, prefix, command, expected in rows:
                with self.subTest(wrapper=wrapper, form=label):
                    self.assertEqual(self.classify((prefix + '; ' if prefix else '') + wrapper + command), expected)
        self.table([
            ('S="with space/safe.py"; offbox run -- python3 "$S"', None),
            ('S="cat ' + LIVE + '"; offbox run -- $S', UNRESOLVED),
            ('S="tmp/live.py extra"; offbox run -- python3 ${S}', UNRESOLVED),
            ('S="tmp/live.py extra"; offbox run -- python3 $S', UNRESOLVED),
            ('S="with space/safe.py"; offbox run -- python3 "${S}"', None),
            ('S=safe; offbox run -- python3 "$S"__suffix__.py', None),
            ('S=tmp/t; python3 "$S"\'.py\'', None),
            ('S=tmp/live; python3 "$S"\'.py\'', SCRIPT),
            ('S=safe.py; offbox run -- python3 "$S"; python3 tmp/live.py', SCRIPT),
            ('S=safe.py; offbox run -- bash -c \'S=tmp/live.py; python3 "$S"\'', SCRIPT),
            ('S=tmp/live.py; offbox run -- bash -c \'S=safe.py; python3 "$S"\'', None),
            ('S=tmp/live.py; offbox run -- \'S=safe.py; python3 "$S"\'', None),
            ('S="python3 safe.py"; offbox run -- "$S"', None),
            ('DB=' + LIVE + '; offbox run -- bash -c "echo \\$S; cat $DB"', READ),
            ('DB=safe.py; offbox run -- bash -c "echo \\$S; python3 $DB"', None),
            ('CODE=\'S=safe.py; python3 "$S"\'; offbox run -- "$CODE"', None),
            ('results_dir=$(mktemp -d); offbox run -- python3 -I - "$results_dir" <<\'PY\'\nimport sys; print(sys.argv[1])\nPY\n', None),
            ('offbox run -- python3 -I - "$(mktemp -d)" <<\'PY\'\nprint(1)\nPY\n', None),
            ('results_dir=$(mktemp -d); offbox run -- python3 -I - "$results_dir" <<\'PY\'\nimport sqlite3; sqlite3.connect(' + repr(LIVE) + ')\nPY\n', READ),
            ('DB=' + LIVE + '; offbox run -- cat \'$DB\' "$DB"', READ),
            ('S=; offbox run -- $S python3 tmp/live.py', UNRESOLVED),
            ('S=; offbox run -- ${S} python3 tmp/live.py', UNRESOLVED),
            ('S=; offbox run -- python3 $S tmp/live.py', UNRESOLVED),
            ('S=; offbox run -- "$S" python3 tmp/live.py', None),
            ('S=; offbox run -- ""$S python3 tmp/live.py', None),
            ('S=; offbox run -- python3 -I - "$S" <<\'PY\'\nprint(1)\nPY\n', None),
        ])

    def test_remote_argv_keeps_literal_dollar_segments(self):
        self.write('$S', 'print(1)')
        self.write('tmp/$S.py', 'print(1)')
        for operand in ["'$S'", r'\$S', r'"\$S"']:
            with self.subTest(operand=operand):
                self.assertEqual(self.classify('S=tmp/live.py; offbox run -- python3 ' + operand), UNRESOLVED)
        self.assertEqual(self.classify('D=tmp; S=live; offbox run -- python3 "$D"/\'$S.py\''), UNRESOLVED)
        self.assertEqual(self.classify('D=tmp; S=live; offbox run -- python3 "$D"/"$S.py"'), SCRIPT)
        self.assertIsNone(self.classify('S=tmp/live.py; offbox run -- cat \'$S\''))

    def test_remote_declarations_keep_conservative_reader_bindings(self):
        declarations = [
            'export DB=' + LIVE,
            'readonly DB=' + LIVE,
            'declare DB=' + LIVE,
            'typeset DB=' + LIVE,
            'local DB=' + LIVE,
            'export -x DB=' + LIVE,
            'declare -x DB=' + LIVE,
            'declare -r DB=' + LIVE,
            'declare -- DB=' + LIVE,
            'DB=' + LIVE + '; export DB',
            'DB=' + LIVE + '; readonly DB',
            'DB=' + LIVE + '; declare DB',
            'DB=' + LIVE + '; export -p',
            'DB=' + LIVE + '; readonly DB; declare X=unrelated',
            'DB=' + LIVE + '; export DB; read DB',
            'readonly DB=' + LIVE + '; DB=tmp/t.py',
            'declare -r DB=' + LIVE + '; DB=tmp/t.py',
        ]
        for wrapper in ['offbox run -- ', 'ssh box ', 'python3 /abs/offbox.py ssh box ']:
            for declaration in declarations:
                for operand in ['"$DB"', '"${DB}"']:
                    with self.subTest(wrapper=wrapper, declaration=declaration, operand=operand):
                        self.assertEqual(self.classify(declaration + '; ' + wrapper + 'cat ' + operand), READ)
            for root in ['/Users/x/.robob/userdata', str(Path.home() / '.t3/userdata')]:
                with self.subTest(wrapper=wrapper, root=root):
                    self.assertEqual(self.classify('export D=' + shlex.quote(root) + '; ' + wrapper + 'cat "$D/statev2.sqlite"'), READ)
                    self.assertEqual(self.classify('export D=' + shlex.quote(root) + '; DB="$D/statev2.sqlite"; ' + wrapper + 'cat "$DB"'), READ)
            alias = 'DB=' + LIVE + '; declare -n REF=DB; ' + wrapper + 'cat "$REF"'
            self.assertIn(self.classify(alias), (READ, UNRESOLVED))
        for declaration in ['export', 'readonly', 'declare', 'typeset', 'local']:
            self.assertIsNone(self.classify(declaration + ' S=tmp/t.py; offbox run -- cat "$S"'))
            self.assertEqual(self.classify(declaration + ' S=tmp/t.py; offbox run -- python3 "$S"'), UNRESOLVED)
        prefix = 'export DB=' + LIVE + '; offbox run -- '
        self.assertIsNone(self.classify(prefix + "cat '$DB'"))
        self.assertIsNone(self.classify(prefix + shlex.quote('DB=tmp/t.py; cat "$DB"')))
        self.assertEqual(self.classify('offbox run -- ' + shlex.quote('export DB=' + LIVE + '; cat "$DB"')), READ)
        self.assertIsNone(self.classify('export DB=' + LIVE + '; CODE=\'REMOTE=tmp/t.py; cat "$REMOTE"\'; offbox run -- "$CODE"'))
        self.assertIsNone(self.classify('export DB=' + LIVE + '; CODE=\'DB=tmp/t.py; cat "$DB"\'; offbox run -- "$CODE"'))
        for assignment in ["S='$DB'", r'S=\$DB', r'S="\$DB"', "export S='$DB'"]:
            with self.subTest(literal_assignment=assignment):
                self.assertIsNone(self.classify('DB=' + LIVE + '; ' + assignment + '; offbox run -- cat "$S"'))
        self.assertIsNone(self.classify('DB=' + LIVE + '; S=\'$DB\'; T="$S"; offbox run -- cat "$T"'))
        self.assertEqual(self.classify('DB=' + LIVE + '; URI="file:$DB?\\$q"; offbox run -- sqlite3 "$URI" .tables'), READ)

    def test_substitution_quotes_cannot_hide_later_documents(self):
        prefixes = [
            "echo \"`printf '\"'`\"",
            "echo `printf '\"'`",
            'echo "`printf "x"`"',
            'echo "$(printf \'"\')"',
            'echo "`printf \'x\'`"',
        ]
        for prefix in prefixes:
            for interpreter, marker, body in [
                ('python3 -', 'PY', 'import sqlite3; sqlite3.connect(' + repr(LIVE) + ')'),
                ('bash -s', 'SH', 'sqlite3 ' + LIVE),
            ]:
                with self.subTest(prefix=prefix, interpreter=interpreter):
                    command = prefix + '\n' + interpreter + " <<'" + marker + "'\n" + body + '\n' + marker + '\n'
                    self.assertEqual(self.classify(command), READ)
        self.assertEqual(self.classify('echo "`python3 - <<\'PY\'\nopen(' + repr(LIVE) + ').read()\nPY\n`"'), READ)

    def test_unsupported_dollar_quotes_fail_closed_in_delimiters(self):
        for raw in ["$'EOF'", '$"EOF"', "E$'OF'", 'E$"OF"', "$'E\\x4fF'"]:
            with self.subTest(raw=raw):
                with self.assertRaises(guard.AmbiguousScript):
                    guard._heredocs('cat <<' + raw + '\nhi\nEOF\n')
                self.assertEqual(self.classify('cat <<' + raw + '\nhi\nEOF\nsqlite3 ' + LIVE + '\n$EOF\n'), UNRESOLVED)

    def test_stdin_programs_keep_positional_arguments_out_of_script_resolution(self):
        rows = [
            ('python3 - "$X"', 'print(1)'),
            ('python3 -I - "$X"', 'print(1)'),
            ('python3 -X dev - "$X"', 'print(1)'),
            ('bash -s "$X"', 'echo hi'),
            ('sh -s -- "$X"', 'echo hi'),
            ('zsh -xs "$X"', 'echo hi'),
            ('dash -s "$X"', 'echo hi'),
            ('ksh -s "$X"', 'echo hi'),
            ('node - "$X"', 'console.log(1)'),
            ('node --input-type=module - "$X"', 'console.log(1)'),
            ('bun - "$X"', 'console.log(1)'),
            ('deno run - "$X"', 'console.log(1)'),
        ]
        for invocation, source in rows:
            with self.subTest(invocation=invocation):
                self.assertIsNone(self.classify(invocation + " <<'EOF'\n" + source + '\nEOF'))
                self.assertIsNone(self.classify(invocation + ' < tmp/t.py'))
        for invocation, source in [
            ('python3 - "$X"', f'open({LIVE!r}).read()'),
            ('python3 -I - "$X"', 'open("~/.local/share/opencode/opencode.db").read()'),
            ('bash -s "$X"', 'cat ~/.robob/userdata/statev2.sqlite'),
            ('sh -xs -- "$X"', 'cat ~/.local/share/opencode/opencode.db'),
            ('node - "$X"', f'require("fs").readFileSync({LIVE!r})'),
            ('bun - "$X"', f'require("fs").readFileSync({LIVE!r})'),
            ('deno run - "$X"', f'Deno.readFileSync({LIVE!r})'),
        ]:
            with self.subTest(invocation=invocation):
                self.assertEqual(self.classify(invocation + " <<'EOF'\n" + source + '\nEOF'), READ)
        self.table([
            ('python3 -I "$X" -', UNRESOLVED),
            ('bash -c "$X"', None),
            ("bash -sc 'python3 \"$X\"'", UNRESOLVED),
            ('python3 - "$X" < ' + LIVE, READ),
            ('cat ' + LIVE + ' | python3 - "$X"', READ),
            ('python3 - "$X" <<< \'print(1)\'', None),
            ('bash -s "$X" <<< \'echo hi\'', None),
            ('node - "$X" <<< \'console.log(1)\'', None),
            ('python3 - "$X" <<< ' + shlex.quote('open(' + repr(LIVE) + ').read()'), READ),
            ('bash -s "$X" <<< ' + shlex.quote('cat ' + LIVE), READ),
            ('python3 - "$X" <<< "$(cat tmp/live.py)"', UNRESOLVED),
            ('python3 - "$X" <<< "$CODE"', UNRESOLVED),
        ])

    def test_literal_variable_scripts_are_resolved_and_inspected(self):
        self.write('tmp/a.sh', 'echo hi')
        self.write('tmp/live.sh', 'cat ' + LIVE)
        self.table([
            ('S=tmp/t.py; python3 "$S"', None),
            ('D=tmp; python3 -I "${D}/t.py"', None),
            ('D=tmp; S="$D/t.py"; python3 "$S"', None),
            ('S=tmp/live.py; python3 "$S"', SCRIPT),
            ('D=tmp; bash "$D/live.sh"', SCRIPT),
            ('python3 "$X/a.py"', UNRESOLVED),
            ('S=tmp/t.py; read S; python3 "$S"', UNRESOLVED),
            ('S=tmp/t.py; unset S; python3 "$S"', UNRESOLVED),
            ('if true; then S=tmp/t.py; fi; python3 "$S"', UNRESOLVED),
            ('S=tmp/live.py; if true; then S=tmp/t.py; fi; python3 "$S"', SCRIPT),
            ('S=tmp/live.py; S=tmp/t.py true; python3 "$S"', SCRIPT),
            ('S=tmp/live.py; env S=tmp/t.py true; python3 "$S"', SCRIPT),
            ('S=tmp/live.py; (S=tmp/t.py); python3 "$S"', SCRIPT),
            ('S=tmp/t.py; S+=x; python3 "$S"', UNRESOLVED),
            ('S=tmp/t.py; declare -n S=OTHER; python3 "$S"', UNRESOLVED),
            ('S=tmp/t.py; printf -v S x; python3 "$S"', UNRESOLVED),
            ('S=-I; python3 "$S" tmp/live.py', UNRESOLVED),
            ('S=-c; bash "$S" "echo hi"', UNRESOLVED),
            ('S="~/tmp/a.py"; python3 "$S"', UNRESOLVED),
            ('S="tmp/t.py extra"; python3 $S', UNRESOLVED),
            ('S="tmp/t.py extra"; python3 $S "$S"', UNRESOLVED),
            ('D="tmp/t.py extra"; F=x; python3 $D/"$F"', UNRESOLVED),
            ('S=tmp/t.py; while true; do python3 "$S"; S=tmp/live.py; done', UNRESOLVED),
        ])

    def test_literal_dollars_do_not_become_script_expansions(self):
        self.write('tmp/with space.py', 'print(1)')
        self.table([
            ('S="tmp/with space.py"; python3 "$S"', None),
            ('S=tmp/t.py; python3 \'$S\'', UNRESOLVED),
            ('S=tmp/t.py; python3 \\$S', UNRESOLVED),
            ('S=tmp/t.py; python3 "\\$S"', UNRESOLVED),
            ('D=tmp; S=\'$D/t.py\'; python3 "$S"', UNRESOLVED),
            ('D=tmp; S="\\$D/t.py"; python3 "$S"', UNRESOLVED),
            ('D=tmp; S=\'$D\'; python3 "$S/$D/t.py"', UNRESOLVED),
            ('D=tmp; python3 "$D/t.py"', None),
            ('D=tmp; bash -c \'python3 "$D/t.py"\'', UNRESOLVED),
        ])

    def test_literal_loop_script_candidates_all_require_inspection(self):
        paths = ['native/scripts/bootstrap-tools.sh', 'native/ssh/build.sh',
                 'native/tests/build-ssh-host.sh', 'native/tests/build-rekey-server.sh',
                 'tmp/vault-native/build-final.sh']
        for path in paths:
            self.write(path, 'echo hi')
        prefix = 'for file in ' + ' '.join(paths) + '; do '
        self.assertIsNone(self.classify(prefix + 'bash -n "$file"; done'))
        self.assertIsNone(self.classify(prefix + 'bash "$file"; done'))
        self.write(paths[2], 'cat ' + LIVE)
        self.assertEqual(self.classify(prefix + 'bash "$file"; done'), SCRIPT)
        self.table([
            ('for f in *.sh; do bash "$f"; done', UNRESOLVED),
            ('for f in $(ls); do bash "$f"; done', UNRESOLVED),
            ('for f in tmp/t.py "$X"; do python3 "$f"; done', UNRESOLVED),
            ('for f; do python3 "$f"; done', UNRESOLVED),
            ('for f in tmp/t.py; do :; done; python3 "$f"', UNRESOLVED),
        ])

    def test_heredoc_variable_scripts_and_invalidated_proofs(self):
        for assignment in ['D=$(mktemp -d)', 'D=tmp']:
            for interpreter, suffix, body in [('python3 -I', 'py', 'print(1)'), ('bash', 'sh', 'echo hi')]:
                prefix = assignment + '; cat > "$D/a.' + suffix + '" <<\'EOF\'\n'
                invoke = '\nEOF\n' + interpreter + ' "$D/a.' + suffix + '"'
                with self.subTest(assignment=assignment, interpreter=interpreter):
                    self.assertIsNone(self.classify(prefix + body + invoke))
                    bad = f'open({LIVE!r}).read()' if suffix == 'py' else 'cat ' + LIVE
                    self.assertEqual(self.classify(prefix + bad + invoke), SCRIPT)
                    bad = 'open("~/.local/share/opencode/opencode.db").read()' if suffix == 'py' else 'cat ~/.local/share/opencode/opencode.db'
                    self.assertEqual(self.classify(prefix + bad + invoke), SCRIPT)
        prefix = 'D=$(mktemp -d); cat > "$D/a.py" <<\'EOF\'\nprint(1)\nEOF\n'
        literal_prefix = prefix.replace('$(mktemp -d)', 'tmp')
        self.assertEqual(self.classify(literal_prefix + 'cp /elsewhere/x.py "$D/a.py"; python3 "$D/a.py"'), UNRESOLVED)
        self.assertEqual(self.classify(literal_prefix + 'printf x > "$D/a.py"; python3 "$D/a.py"'), UNRESOLVED)
        self.table([
            (prefix + 'python3 "$D/b.py"', UNRESOLVED),
            (prefix + 'D=$(other); python3 "$D/a.py"', UNRESOLVED),
            (prefix + 'D=/elsewhere; python3 "$D/a.py"', None),
            (prefix + 'cp /elsewhere/x.py "$D/a.py"; python3 "$D/a.py"', UNRESOLVED),
            (prefix + 'mv /elsewhere/x.py "$D/a.py"; python3 "$D/a.py"', UNRESOLVED),
            (prefix + 'printf x > "$D/a.py"; python3 "$D/a.py"', UNRESOLVED),
            (prefix + 'cat /elsewhere/x.py > "$D/a.py"; python3 "$D/a.py"', UNRESOLVED),
            (prefix + 'tee "$D/a.py" < /elsewhere/x.py; python3 "$D/a.py"', UNRESOLVED),
            (prefix + 'E="$D"; cat > "$E/a.py" <<\'EOF\'\nprint(2)\nEOF\npython3 "$D/a.py"', UNRESOLVED),
            (prefix + 'cat > "${D}/a.py" <<\'EOF\'\nprint(2)\nEOF\npython3 "$D/a.py"', UNRESOLVED),
            (prefix + "python3 '$D/a.py'", UNRESOLVED),
            ('cat > "$X/a.py" <<\'EOF\'\nprint(1)\nEOF\npython3 "$X/a.py"', UNRESOLVED),
            ('D=$(mktemp -d); if true; then cat > "$D/a.py" <<\'EOF\'\nprint(1)\nEOF\nfi; python3 "$D/a.py"', UNRESOLVED),
            (prefix + 'cat >> "$D/a.py" <<\'EOF\'\nprint(2)\nEOF\npython3 "$D/a.py"', None),
            (prefix + 'cat >> "$D/a.py" <<\'EOF\'\nopen(' + repr(LIVE) + ').read()\nEOF\npython3 "$D/a.py"', SCRIPT),
            ('D=$(mktemp -d); cat >> "$D/a.py" <<\'EOF\'\nprint(1)\nEOF\npython3 "$D/a.py"', UNRESOLVED),
        ])

    def test_interpreter_execution_invalidates_prior_source_proofs(self):
        python = "from pathlib import Path\nPath('tmp/a.py').write_text(Path('tmp/read.py').read_text())\n"
        javascript = "require('fs').copyFileSync('tmp/read.py', 'tmp/a.py')\n"
        shell = 'cp tmp/read.py tmp/a.py\n'
        self.write('tmp/a.py', 'print(1)\n')
        self.write('tmp/read.py', 'open(' + repr(LIVE) + ').read()\n')
        self.write('tmp/writer.py', python)
        self.write('tmp/writer.js', javascript)
        self.write('tmp/writer.sh', shell)
        prefix = 'D=tmp; cat > "$D/a.py" <<\'EOF\'\nprint(1)\nEOF\n'
        invoke = '\npython3 "$D/a.py"'
        rows = [
            ('python file', 'python3 tmp/writer.py'),
            ('python file argv', 'python3 tmp/writer.py -c "print(1)"'),
            ('python module', 'python3 -m tmp.writer'),
            ('python stdin', "python3 - <<'PY'\n" + python + 'PY'),
            ('python stdin argv', "python3 -I - \"$X\" <<'PY'\n" + python + 'PY'),
            ('python implicit stdin', "python3 <<'PY'\n" + python + 'PY'),
            ('python redirected stdin', 'python3 - < tmp/writer.py'),
            ('python piped stdin', 'cat tmp/writer.py | python3 -'),
            ('python here-string', 'python3 - <<< ' + shlex.quote(python)),
            ('python inline', 'python3 -c ' + shlex.quote(python)),
            ('python bound destination', "python3 - <<'PY'\nfrom pathlib import Path\np=Path('tmp/a.py')\np.write_text(Path('tmp/read.py').read_text())\nPY"),
            ('python unknown destination', "python3 - <<'PY'\nimport sys\nopen(sys.argv[1], 'w').write('print(1)')\nPY"),
            ('python global destination', "python3 - <<'PY'\ndef change():\n global p\n p='tmp/a.py'\np='tmp/report.txt'\nchange()\nopen(p, 'w').write(open('tmp/read.py').read())\nPY"),
            ('shell file', 'bash tmp/writer.sh'),
            ('shell stdin', "bash -s \"$X\" <<'SH'\n" + shell + 'SH'),
            ('node file', 'node tmp/writer.js'),
            ('node stdin', "node - <<'JS'\n" + javascript + 'JS'),
            ('bun file', 'bun run tmp/writer.js'),
            ('bun stdin', "bun - <<'JS'\n" + javascript + 'JS'),
            ('deno file', 'deno run tmp/writer.js'),
            ('deno stdin', "deno run - <<'JS'\nDeno.copyFileSync('tmp/read.py', 'tmp/a.py')\nJS"),
            ('direct script', './tmp/writer.sh'),
            ('command wrapper', 'command python3 tmp/writer.py'),
            ('env wrapper', 'env python3 tmp/writer.py'),
            ('uv wrapper', 'uv run python3 tmp/writer.py'),
            ('offbox wrapper', 'offbox run -- python3 tmp/writer.py'),
            ('loop next iteration', 'for i in one two; do python3 "$D/a.py"; python3 tmp/writer.py; done'),
        ]
        for label, writer in rows:
            with self.subTest(form=label):
                self.assertEqual(self.classify(prefix + writer + invoke), UNRESOLVED)
        self.assertIsNone(self.classify(prefix + invoke))
        self.assertIsNone(self.classify(prefix + 'python3 -I -c "print(1)"' + invoke))
        self.assertIsNone(self.classify(prefix + 'bash -n tmp/writer.sh' + invoke))
        self.assertEqual(self.classify(prefix + 'bash -nc "echo hi"' + invoke), UNRESOLVED)
        with patch.dict(os.environ, {'BASH_ENV': '/tmp/guard841-shell-env.sh'}):
            self.assertEqual(self.classify(prefix + 'bash -n tmp/writer.sh' + invoke), UNRESOLVED)
        other_edit = "python3 - <<'PY'\nfrom pathlib import Path\np=Path('tmp/report.txt')\np.write_text('report')\nPY"
        self.assertIsNone(self.classify(prefix + other_edit + invoke))
        other_edit_live_read = other_edit.replace("'report'", 'open(' + repr(LIVE) + ').read()')
        self.assertEqual(self.classify(prefix + other_edit_live_read + invoke), READ)
        (self.root / 'tmp/report.txt').symlink_to('a.py')
        self.assertEqual(self.classify(prefix + other_edit + invoke), UNRESOLVED)

    def test_script_write_destinations_require_distinct_files(self):
        target = self.write('tmp/a.py', 'print(1)\n')
        self.write('tmp/read.py', 'open(' + repr(LIVE) + ').read()\n')
        self.write('tmp/unrelated.txt', 'print(1)\n')
        (self.root / 'tmp/symlink.txt').symlink_to('a.py')
        os.link(target, self.root / 'tmp/report.txt')
        prefix = 'D=tmp; cat > "$D/a.py" <<\'EOF\'\nprint(1)\nEOF\n'
        invoke = '\npython3 "$D/a.py"'
        destinations = [
            ('same path', 'tmp/a.py', UNRESOLVED),
            ('symlink', 'tmp/symlink.txt', UNRESOLVED),
            ('hard link', 'tmp/report.txt', UNRESOLVED),
            ('distinct file', 'tmp/unrelated.txt', None),
            ('new file', 'tmp/new.txt', None),
        ]
        writes = [
            "Path({dest!r}).write_text(Path('tmp/read.py').read_text())",
            "Path({dest!r}).write_bytes(Path('tmp/read.py').read_bytes())",
            "open({dest!r}, 'w').write(open('tmp/read.py').read())",
            "open({dest!r}, 'a').write(open('tmp/read.py').read())",
            "open({dest!r}, 'wb').write(open('tmp/read.py', 'rb').read())",
            "open({dest!r}, 'ab').write(open('tmp/read.py', 'rb').read())",
        ]
        for label, destination, expected in destinations:
            for write in writes:
                with self.subTest(alias=label, write=write):
                    source = 'from pathlib import Path\n' + write.format(dest=destination)
                    command = prefix + "python3 - <<'PY'\n" + source + '\nPY' + invoke
                    self.assertEqual(self.classify(command), expected)
        source = 'from pathlib import Path\n' + writes[0].format(dest='tmp/unrelated.txt')
        command = prefix + "python3 - <<'PY'\n" + source + '\nPY' + invoke
        path_stat = Path.stat
        for name in ['tmp/unrelated.txt', 'tmp/a.py']:
            blocked_path = Path(os.path.realpath(self.root / name))
            def unavailable_stat(path, *args, **kwargs):
                if path == blocked_path:
                    raise PermissionError('fixture identity unavailable')
                return path_stat(path, *args, **kwargs)
            with self.subTest(unavailable=name), patch.object(Path, 'stat', new=unavailable_stat):
                self.assertEqual(self.classify(command), UNRESOLVED)

    def test_shell_writes_invalidate_hard_linked_script_proofs(self):
        target = self.write('tmp/a.py', 'print(1)\n')
        self.write('tmp/read.py', 'open(' + repr(LIVE) + ').read()\n')
        os.link(target, self.root / 'tmp/report.txt')
        prefix = 'D=tmp; cat > "$D/a.py" <<\'EOF\'\nprint(1)\nEOF\n'
        for writer in ['cat tmp/read.py > tmp/report.txt', 'tee tmp/report.txt < tmp/read.py']:
            with self.subTest(writer=writer):
                self.assertEqual(self.classify(prefix + writer + '\npython3 "$D/a.py"'), UNRESOLVED)

    def test_exact_variable_script_reporters(self):
        fixtures = Path(__file__).with_name('fixtures') / 'variable-scripts'
        for name in ['card3409', 'card3650', 'card937', 'torssh31']:
            command = (fixtures / (name + '.sh')).read_text()
            with self.subTest(reporter=name):
                self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))
        command = (fixtures / 'card3409.sh').read_text().replace('$(mktemp -d /tmp/card-3409-writer.XXXXXX)', str(self.root / 'writer'))
        self.assertIsNone(self.classify(command))
        command = (fixtures / 'card4079.sh').read_text()
        historical_root = '/Volumes/ExternalSSD/crpko-devops/tmp/readbacks/risk-liquidation-docs128-dev.1-card4079'
        command = command.replace(historical_root, str(self.root / 'readback'))
        self.write('readback/probe-manifest.sh', 'echo hi')
        self.assertIsNone(self.classify(command))
        self.write('readback/probe-manifest.sh', 'cat ' + LIVE)
        self.assertEqual(self.classify(command), SCRIPT)

    def test_variable_path_expansion_bounds_and_candidate_products(self):
        self.write('one/safe.py', 'print(1)')
        self.write('two/live.py', 'open(' + repr(LIVE) + ').read()')
        self.table([
            ('for D in one two; do for F in safe.py live.py; do python3 "$D/$F"; done; done', SCRIPT),
            ('for D in one two; do for F in safe.py; do python3 "$D/$F"; done; done', None),
            ('for D in one two; do cd "$D"; python3 safe.py; done', UNRESOLVED),
            ('D=tmp; if true; then D=$(unknown); fi; python3 "$D/t.py"', UNRESOLVED),
        ])
        words = ' '.join('dir' + str(i) for i in range(guard.MAX_SCRIPTS + 1))
        self.assertEqual(self.classify('for D in ' + words + '; do python3 "$D/a.py"; done'), UNRESOLVED)

    def test_variable_script_review_corpus(self):
        corpus = json.loads((Path(__file__).with_name('fixtures') / 'variable-scripts/review-corpus.json').read_text())
        for name, source in corpus['files'].items():
            self.write(name, source)
        for label, command in corpus['cases']:
            with self.subTest(case=label):
                self.assertIn(self.classify(command), {READ, SCRIPT, UNRESOLVED})
        for label, command in corpus['allow_cases']:
            with self.subTest(case=label):
                self.assertIsNone(self.classify(command))
        fallback = '$D' + str(self.root / 'tmp/read.py')
        command = 'D=$(mktemp -d invalid) && cat > "' + fallback + '" <<\'EOF\'\nprint(1)\nEOF\npython3 "' + fallback + '"'
        self.assertEqual(self.classify(command), SCRIPT)
        self.table([
            ('D=$(printf tmp); cat > "$D/new.py" <<\'EOF\'\nprint(1)\nEOF\npython3 "$D/new.py"', UNRESOLVED),
            ('D=$(mktemp -d); cp tmp/read.py "$D/a.py"; chmod a-w "$D/a.py"; cat > "$D/a.py" <<\'EOF\'\nprint(1)\nEOF\npython3 "$D/a.py"', UNRESOLVED),
            ('D=$(mktemp -d); cat > "$D/a.py" <<\'EOF\'\nprint(1)\nEOF\n./writer.sh; cat > "$D/a.py" <<\'EOF\'\nprint(2)\nEOF\npython3 "$D/a.py"', UNRESOLVED),
        ])
        bad = 'from pathlib import Path\nq=".robob"\np=Path.home()/q/"userdata"/"statev2.sqlite"\np.read_bytes()\n'
        for assignment in ['D=tmp', 'D=$(mktemp -d)']:
            command = assignment + '; cat > "$D/new.py" <<\'EOF\'\n' + bad + 'EOF\ncat >> "$D/new.py" <<\'EOF\'\nq=".robob"\nprint(1)\nEOF\npython3 "$D/new.py"'
            self.assertEqual(self.classify(command), SCRIPT)

    def test_opaque_sources_must_stay_inside_the_fresh_root(self):
        self.write('tmp/safe.py', 'print(1)')
        self.write('tmp/read.py', 'open(' + repr(LIVE) + ').read()')
        template = str(self.root / 'fresh.XXXXXX')
        for target, expected in [
            ('$D/a.py', None),
            ('${D}/sub/a.py', None),
            ('$D/../tmp/read.py', UNRESOLVED),
            ('${D}/./../tmp/read.py', UNRESOLVED),
            ('$D/sub/../../tmp/read.py', UNRESOLVED),
            ('prefix/$D/a.py', UNRESOLVED),
            ('$D/$D/a.py', UNRESOLVED),
        ]:
            with self.subTest(target=target):
                command = 'D=$(mktemp -d ' + template + '); mkdir tmp/safe.py && cat > "' + target + '" <<\'EOF\'\nprint(1)\nEOF\npython3 "' + target + '"'
                self.assertEqual(self.classify(command), expected)

    def test_isolated_migrate_source_and_note_case_matrix(self):
        source = Path(__file__).resolve().parents[3] / 'apps/server/scripts/migrate-dev-db.ts'
        self.write('apps/server/scripts/migrate-dev-db.ts', source.read_text())
        self.write('package.json', json.dumps({'scripts': {'migrate-dev-db': 'node apps/server/scripts/migrate-dev-db.ts'}}))
        (self.root / 'link.sqlite').symlink_to(Path.home() / '.robob/userdata/statev2.sqlite')
        for label, command, expected in isolated_source_cases.cases(self.root):
            with self.subTest(case=label, command=command):
                self.assertEqual(guard.classify_detail(command, str(self.root))[0], expected)

    def test_node_test_database_names_and_live_root_siblings(self):
        for label, source, expected in isolated_source_cases.database_name_sources():
            self.write('names.test.mjs', source)
            for command in ('node --test names.test.mjs', 'node names.test.mjs',
                            'offbox run -- node --test names.test.mjs'):
                with self.subTest(case=label, command=command):
                    self.assertEqual(self.classify(command), expected)

    def test_installer_node_test_and_parse_only_commands(self):
        root = Path(__file__).resolve().parents[3]
        for command in (
            'node --test apps/desktop/scripts/install-robob-fast.test.mjs',
            'node --check apps/desktop/scripts/install-robob-fast.mjs',
            'zsh -n apps/desktop/scripts/install-robob-fast.zsh',
            'offbox run -- node --test apps/desktop/scripts/install-robob-fast.test.mjs',
            'vp test run apps/desktop/scripts/install-robob-fast.test.mjs',
        ):
            with self.subTest(command=command):
                self.assertIsNone(guard.classify(command, str(root)))

    def test_node_test_refusal_only_hints_for_vitest_imports(self):
        for module in ('node:test', 'vitest', 'vite-plus/test', None):
            source = f'import {{ test }} from "{module}";\n' if module else '// fixture\n'
            self.write('names.test.mjs', source + 'const db = "~/.robob/userdata/statev2.sqlite";\n')
            with self.subTest(module=module):
                rule, detail = guard.classify_detail('node --test names.test.mjs', str(self.root))
                self.assertEqual(rule, SCRIPT)
                self.assertIn('names.test.mjs:2', detail)
                self.assertIn('~/.robob/userdata/statev2.sqlite', detail)
                self.assertEqual('vp test run names.test.mjs' in detail, module in {'vitest', 'vite-plus/test'})

    def test_migration_exemption_checks_source_and_plain_node_invocation(self):
        source = Path(__file__).resolve().parents[3] / 'apps/server/scripts/migrate-dev-db.ts'
        original = source.read_text()
        self.write('apps/server/scripts/migrate-dev-db.ts', original)
        self.write('package.json', json.dumps({'scripts': {'migrate-dev-db': 'node apps/server/scripts/migrate-dev-db.ts'}}))
        invocation = 'node apps/server/scripts/migrate-dev-db.ts --source /tmp/copy.sqlite --base-dir /tmp/dev-home'
        self.assertIsNone(self.classify(invocation))
        self.assertEqual(self.classify('node --test apps/server/scripts/migrate-dev-db.ts --source /tmp/copy.sqlite'), SCRIPT)
        self.write('apps/server/scripts/migrate-dev-db.ts', original + '\nrequire("fs").readFileSync(' + repr(LIVE) + ');\n')
        self.assertEqual(self.classify(invocation), SCRIPT)
        self.assertEqual(self.classify('vp run migrate-dev-db --source /tmp/copy.sqlite --base-dir /tmp/dev-home'), SCRIPT)
        self.write('package.json', json.dumps({'scripts': {'migrate-dev-db': 'node other.ts'}}))
        self.assertEqual(self.classify('vp run migrate-dev-db --source /tmp/copy.sqlite'), UNRESOLVED)

    def test_exact_isolated_source_reporters_are_data(self):
        fixture_dir = Path(__file__).with_name('fixtures') / 'isolated-source'
        fixtures = sorted(fixture_dir.glob('*.json'))
        # Freeze all historical roots; stat/open behavior is exercised above
        # against the real migration source and controlled temporary scripts.
        with patch.object(os.path, 'realpath', side_effect=lambda p, *a, **kw: os.path.abspath(p)), patch.object(Path, 'stat', side_effect=FileNotFoundError):
            for fixture in fixtures:
                row = json.loads(fixture.read_text())
                for call in row['commands']:
                    with self.subTest(case=row['case'], fixture=fixture.name):
                        self.assertEqual(guard.classify_detail(call['cmd'], call['workdir'] or row['session_cwd']), (None, None))

    def test_mktemp_fixture_rooted_shell_source_and_near_misses(self):
        source = Path(__file__).resolve().parents[3] / 'integrations/memory-system/tests/test_backup_replica.sh'
        self.write('integrations/memory-system/tests/test_backup_replica.sh', source.read_text())
        for command in ('bash integrations/memory-system/tests/test_backup_replica.sh',
                        '/bin/bash ' + str(self.root / 'integrations/memory-system/tests/test_backup_replica.sh')):
            with self.subTest(case='w', command=command):
                self.assertIsNone(self.classify(command))
        self.assertEqual(self.classify('sed -i "s/mktemp/echo/g" integrations/memory-system/tests/test_backup_replica.sh; bash integrations/memory-system/tests/test_backup_replica.sh'), SCRIPT)
        self.assertEqual(self.classify('BASH_ENV=/tmp/preload.sh bash integrations/memory-system/tests/test_backup_replica.sh'), SCRIPT)
        self.write('tmp/fixtu\nre.sh', source.read_text())
        self.assertEqual(self.classify('bash tmp/fixtu\\\nre.sh'), SCRIPT)
        with patch.dict(os.environ, {'BASH_FUNC_mktemp%%': '() { echo "$HOME"; }'}):
            self.assertEqual(self.classify('bash integrations/memory-system/tests/test_backup_replica.sh'), SCRIPT)
        self.write('integrations/memory-system/tests/test_backup_replica.sh', source.read_text() + '\n# changed body\n')
        self.assertIsNone(self.classify('bash integrations/memory-system/tests/test_backup_replica.sh'))
        for source, expected in isolated_source_cases.mktemp_scripts():
            self.write('tmp/fixture.sh', source)
            with self.subTest(source=source):
                self.assertEqual(self.classify('bash tmp/fixture.sh'), expected)

    def test_mktemp_fixture_plain_subpaths(self):
        backup = Path(__file__).resolve().parents[3] / 'integrations/memory-system/tests/test_backup_replica.sh'
        original = backup.read_text()
        path = 'tmp/fixture.sh'
        commands = ('bash ' + path, '/bin/bash ' + str(self.root / path),
                    'offbox run --bg -- bash ' + path)
        for directory in ('fixture-live/userdata', 'fixture', 'fixture_2/a.b-c_0/7'):
            for database in ('statev2', 'statev2.sqlite', 'statev2.sqlite-wal',
                             'statev2.sqlite-shm', 'statev2.sqlite-journal', 'statev2-wal'):
                source = original.replace('/.robob/userdata/statev2.sqlite', '/' + directory + '/' + database)
                self.write(path, source)
                for command in commands:
                    with self.subTest(directory=directory, database=database, command=command):
                        self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))

    def test_mktemp_fixture_plain_subpath_near_misses(self):
        backup = Path(__file__).resolve().parents[3] / 'integrations/memory-system/tests/test_backup_replica.sh'
        original = backup.read_text().replace('/.robob/userdata/statev2.sqlite', '/fixture-live/userdata/statev2.sqlite')
        path = 'tmp/fixture.sh'
        variants = [(assignment, original.replace('T=$(mktemp -d "$TOP/case.XXXXXX")', assignment))
                    for assignment in ('T=tmp', 'T=$HOME', 'T="$ROBOB_HOME"')]
        for suffix in ('../../.robob/userdata/statev2.sqlite', './fixture/statev2.sqlite',
                       'fixture/../userdata/statev2.sqlite', '$X/statev2.sqlite',
                       'fixture*/statev2.sqlite', 'fixture?/statev2.sqlite',
                       'fixture[ab]/statev2.sqlite', r'fixt\ure/statev2.sqlite',
                       'fixt"ure"/statev2.sqlite', "fixt'ure'/statev2.sqlite",
                       'fixture/statev2.sqlite/../../real', 'fixture/statev2.sqlite$X',
                       'fixture/statev2.sqlite*', 'fixture/statev2.sqlite.backup'):
            variants.append((suffix, original.replace('fixture-live/userdata/statev2.sqlite', suffix)))
        for statement in ('cat ~/.robob/userdata/statev2.sqlite',
                          'cat "$HOME/.ro""bob/userdata/state""v2.sqlite"',
                          'grep needle "$HOME/robob-""data/userdata/state""v2.sqlite"',
                          'cat "$HOME/.local/share/open""code/open""code.db"',
                          'sqlite3 "$HOME/.robob/userdata/statev2.sqlite"',
                          'cat "$T/fixture-live/userdata/statev2.sqlite"'):
            variants.append(('after-reset-lifetime:' + statement, original + '\n' + statement + '\n'))
        live = '"$HOME/.ro""bob/userdata/state""v2.sqlite"'
        for statement in ('cat "$(cat ' + live + ')"',
                          'cat `cat ' + live + '`',
                          'cat "${UNSET:-$(cat ' + live + ')}"',
                          'cat "${UNSET:-$HOME/.ro""bob/userdata/state""v2.sqlite}"',
                          'cat harmless#suffix ' + live,
                          'cat harmless\\#suffix ' + live,
                          'cat harmless\\ #suffix "$(cat ' + live + ')"'):
            variants.append(('split-live-expression:' + statement, original + '\n' + statement + '\n'))
        for statement in ('X=\ncat "$HOME/.ro${X}bob/userdata/state""v2.sqlite"',
                          'X=\ngrep needle "$HOME/.ro${X}bob/userdata/state""v2.sqlite"',
                          'X="$HOME/.ro""bob"\ncat "${X}/userdata/state""v2.sqlite"',
                          'cat "$(printf \'%b\' \'\\057Users\\057x\\057.ro\\142ob\\057userdata\\057statev2.sqli\\164e\')"',
                          '"$PYTHON" -c \'import sys; open(sys.argv[1]).read()\' ' + live,
                          'X=\n"$PYTHON" - "$HOME/.ro${X}bob/userdata/state""v2.sqlite" <<\'PY\'\nimport sys\nopen(sys.argv[1]).read()\nPY'):
            variants.append(('unproved-reader:' + statement, original + '\n' + statement + '\n'))
        for statement in ('cat "$HOME/.ro""bob/userdata/state\\\nv2.sqlite"',
                          'cat "$HOME/.ro""bob/userdata/"$\'statev2.sqli\\x74e\'',
                          'cat "$HOME/.ro""bob/userdata/"$"statev2.sqlite"'):
            variants.append(('bash-quoting:' + statement, original + '\n' + statement + '\n'))
        for program in ('open("/Users/x/.ro" + "bob/userdata/state" + "v2.sqlite").read()',
                        'open(b"/Users/x/.ro" + b"bob/userdata/state" + b"v2.sqlite").read()',
                        'open(f"/Users/x/.{\"ro\"}{\"bob\"}/user{\"data\"}/state{\"v2\"}.sqli{\"te\"}").read()',
                        'open("".join(["/Users/x/.", "ro", "bob/user", "data/state", "v2.sqli", "te"])).read()'):
            for statement in ('"$PYTHON" -c ' + shlex.quote(program),
                              '"$PYTHON" - <<\'PY\'\n' + program + '\nPY'):
                variants.append(('python-built-target:' + statement, original + '\n' + statement + '\n'))
        for update in ('p += segment', 'p = p + segment'):
            program = ('p = ""\nfor segment in ["/Users/synthetic/.", "ro", "bob/user", "data/state", "v2.sqli", "te"]:\n'
                       '    ' + update + '\nopen(p).read()')
            for statement in ('"$PYTHON" -c ' + shlex.quote(program),
                              '"$PYTHON" - <<\'PY\'\n' + program + '\nPY'):
                variants.append(('python-accumulated-target:' + update, original + '\n' + statement + '\n'))
            if update == 'p = p + segment':
                statement = ('"$PYTHON" - "$HERE/src" <<\'PY\'\nimport sys\nsys.path.insert(0, sys.argv[1])\n'
                             'import transcript_backup_manifest as tbm\n' + program + '\nPY')
                variants.append(('manifest-string-accumulation', original + '\n' + statement + '\n'))
                spoofed = ('for directory, p, segment in os.walk(sys.argv[2]):\n    pass\n' + program)
                statement = ('"$PYTHON" - "$HERE/src" "$T" <<\'PY\'\nimport os, sys\nsys.path.insert(0, sys.argv[1])\n'
                             'import transcript_backup_manifest as tbm\n' + spoofed + '\nPY')
                variants.append(('manifest-list-binding-reassigned', original + '\n' + statement + '\n'))
        for program in ('p = "etilqs.2vetats/atadresu/bobor./citehtnys/sresU/"[::-1]\nopen(p).read()',
                        'p = sys.argv[2][::-1]\nopen(p).read()',
                        'p = os.path.join(sys.argv[2], "etilqs.2vetats/atadresu/bobor./citehtnys/sresU/"[::-1])\nopen(p).read()',
                        'p = json.loads(' + repr('"' + ''.join('\\u%04x' % ord(char) for char in '/Users/synthetic/.robob/userdata/statev2.sqlite') + '"') + ')\nopen(p).read()'):
            statement = ('"$PYTHON" - "$HERE/src" "$T" <<\'PY\'\nimport os, sys, json\nsys.path.insert(0, sys.argv[1])\n'
                         'import transcript_backup_manifest as tbm\n' + program + '\nPY')
            variants.append(('manifest-unproved-read-target', original + '\n' + statement + '\n'))
        for value in ('$HOME', '$T/restore$HOME/stage', '$T/restore$T/../../stage'):
            variants.append(('snapshot-root:' + value, original.replace('SNAPROOT="$T/restore$T/stage"', 'SNAPROOT="' + value + '"')))
        # A heredoc body run as a child script has no mktemp root: an empty $T
        # turns a plain subpath into an absolute one.
        for target in ('$T/Volumes/ExternalSSD/robob-data/userdata/statev2.sqlite',
                       '${T}/Volumes/ExternalSSD/robob-data/userdata/statev2.sqlite',
                       '$T/Users/synthetic/robob-data/userdata/statev2.sqlite-wal'):
            body = '/bin/cat "' + target + '" > "$HOME/leak"\n'
            variants.append(('heredoc-quoted-body:' + target, original.replace(
                'echo "$$" > "$HOME/sync-pid"\n', 'echo "$$" > "$HOME/sync-pid"\n' + body, 1)))
            variants.append(('heredoc-unquoted-body:' + target, original.replace(
                '"$REAL_RSYNC" "\\$@" || exit \\$?\n', '"$REAL_RSYNC" "\\$@" || exit \\$?\n' + body.replace('$T', '\\$T'), 1)))
            variants.append(('heredoc-tab-body:' + target, original + "\ncat > \"$R/bin/extra\" <<-'SH'\n\t#!/bin/bash\n\t" + body + "\tSH\n"))
        # Discounting one root's main-shell words must not shift where the
        # heredoc bodies are when another root's words are checked.
        opener = 'cat > "$R/bin/sqlite3_rsync" <<\'SH\'\n#!/bin/bash\necho "$$" > "$HOME/sync-pid"\n'
        for padding in ('echo "$TOP/fixture/statev2.sqlite" "$T/fixture/statev2.sqlite"\n',
                        'echo "$T/fixture/statev2.sqlite" "$TOP/fixture/statev2.sqlite"\n',
                        'echo "$TOP/fixture/statev2.sqlite"\n', 'echo "$T/fixture/statev2.sqlite"\n'):
            for count in (1, 10, 100):
                for reader in ('T', 'TOP'):
                    body = '/bin/cat "$' + reader + '/Volumes/ExternalSSD/robob-data/userdata/statev2.sqlite" > "$HOME/leak"\n'
                    variants.append(('heredoc-after-discounts:%s:%d:%s' % (padding.strip(), count, reader),
                                     original.replace(opener, padding * count + opener + body, 1)))
        variants.append(('before-setup', original.replace('# 1. sync', 'cat "$T/fixture-live/userdata/statev2.sqlite"\n# 1. sync')))
        variants.append(('quote-concatenated-tail', original.replace(
            '"$T/fixture-live/userdata/statev2.sqlite"', '"$T/fixture-live/userdata/statev2.sqlite"/../../real')))
        variants.append(('string-built-home', original + "\n/opt/homebrew/bin/python3 - <<'PY'\nimport os\nroot = os.path.join(os.environ['HOME'], '.ro' + 'bob', 'userdata', 'statev2.sqlite')\nopen(root).read()\nPY\n"))
        for label, source in variants:
            self.assertNotEqual(source, original, label)
            self.write(path, source)
            for command in ('bash ' + path, '/bin/bash ' + str(self.root / path),
                            'offbox run --bg -- bash ' + path):
                with self.subTest(case=label, command=command):
                    self.assertEqual(self.classify(command), SCRIPT)
        self.write(path, original)
        for command in ('sed -i "s/mktemp/echo/g" ' + path + '; bash ' + path,
                        'BASH_ENV=/tmp/preload.sh bash ' + path,
                        'BASH_ENV=/tmp/preload.sh offbox run --bg -- bash ' + path):
            with self.subTest(command=command):
                self.assertEqual(self.classify(command), SCRIPT)
        # offbox can fall back to a local run, so its payload inherits the
        # caller's startup bindings however they were set.
        for wrapper in ('offbox run -- ', 'offbox run --bg -- ', 'offbox run --remote --no-fallback -- '):
            for prefix in ('BASH_ENV=/tmp/preload.sh ', 'ENV=/tmp/preload.sh ', 'env BASH_ENV=/tmp/preload.sh ',
                           'export BASH_ENV=/tmp/preload.sh; ', 'BASH_ENV=/tmp/preload.sh; export BASH_ENV; ',
                           'PATH=/tmp/shadow:$PATH ', 'SHELLOPTS=xtrace '):
                command = prefix + wrapper + 'bash ' + path
                with self.subTest(command=command):
                    self.assertEqual(self.classify(command), SCRIPT)
            with self.subTest(command=wrapper + 'bash ' + path):
                self.assertIsNone(self.classify(wrapper + 'bash ' + path))
        with patch.dict(os.environ, {'BASH_FUNC_mktemp%%': '() { echo "$HOME"; }'}):
            self.assertEqual(self.classify('bash ' + path), SCRIPT)
            self.assertEqual(self.classify('offbox run --bg -- bash ' + path), SCRIPT)
        # The snapshot root repeats $T, so an inherited temp prefix with parent
        # segments (or one the script reassigns) must void the fixture proof.
        commands = ('bash ' + path, '/bin/bash ' + str(self.root / path), 'offbox run --bg -- bash ' + path)
        for prefix in ('relative/tmp', '/tmp/../..', '/tmp/x/../../Users'):
            with patch.dict(os.environ, {'TMPDIR': prefix}):
                for command in commands:
                    with self.subTest(tmpdir=prefix, command=command):
                        self.assertEqual(self.classify(command), SCRIPT)
        self.write(path, 'TMPDIR=/tmp/../..\n' + original)
        for command in commands:
            with self.subTest(case='script-assigns-tmpdir', command=command):
                self.assertEqual(self.classify(command), SCRIPT)

    def repo_node_pin(self, init=None, select=None, wrapper=None):
        """A temp HOME carrying a repo-node-pin chain shaped like the fork's."""
        source = Path(__file__).resolve().parents[2] / 'local-helpers/libexec/repo-node-pin'
        home = self.root / 'home'
        helper = home / '.local/libexec/repo-node-pin'
        (helper / 'pnpm-bin').mkdir(parents=True, exist_ok=True)
        (helper / 'pnpm-bin/pnpm').write_text('#!/bin/sh\n')
        (helper / 'bash-env.sh').write_text((source / 'bash-env.sh').read_text() if wrapper is None else wrapper)
        (helper / 'init.sh').write_text((source / 'init.sh').read_text() if init is None else init)
        (helper / 'select.py').write_text((source / 'select.py').read_text() if select is None else select)
        (home / '.nvm/versions/node/v26.0.0/bin').mkdir(parents=True, exist_ok=True)
        (home / '.nvm/versions/node/v26.0.0/bin/node').write_text('')
        environment = {'HOME': str(home), 'BASH_ENV': str(helper / 'bash-env.sh'),
                       'ROBOB_REPO_PREVIOUS_BASH_ENV': '', 'ROBOB_REPO_NODE_HELPER': '',
                       'ROBOB_REPO_NODE_PYTHON': '', 'NVM_DIR': str(home / '.nvm'), '_repo_node_added_node': '', 'ZDOTDIR': ''}
        return home, helper, environment

    def write_plain_subpath_fixture(self):
        backup = Path(__file__).resolve().parents[3] / 'integrations/memory-system/tests/test_backup_replica.sh'
        self.write('tmp/fixture.sh', backup.read_text().replace('/.robob/userdata/statev2.sqlite', '/fixture-live/userdata/statev2.sqlite'))
        return ('bash tmp/fixture.sh', '/bin/bash ' + str(self.root / 'tmp/fixture.sh'),
                'offbox run --bg -- bash tmp/fixture.sh')

    def test_inherited_repo_node_pin_bash_env_keeps_fixture_proof(self):
        commands = self.write_plain_subpath_fixture()
        home, helper, environment = self.repo_node_pin()
        with patch.dict(os.environ, environment):
            for command in commands:
                with self.subTest(command=command):
                    self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))
            # The previous BASH_ENV may equal this one (init.sh's own guard).
            with patch.dict(os.environ, {'ROBOB_REPO_PREVIOUS_BASH_ENV': environment['BASH_ENV'],
                                         'ROBOB_REPO_NODE_HELPER': str(helper),
                                         'ROBOB_REPO_NODE_PYTHON': '/opt/homebrew/bin/python3'}):
                self.assertIsNone(self.classify(commands[0]))
            self.assertIsNone(self.classify('bash -n tmp/fixture.sh'))
            # Bindings the command sets are never inherited.
            for prefix in ('BASH_ENV=/tmp/preload.sh ', 'BASH_ENV=' + environment['BASH_ENV'] + ' ',
                           'ENV=/tmp/preload.sh ', 'export BASH_ENV=/tmp/preload.sh; ', 'env BASH_ENV=/tmp/preload.sh ',
                           'PATH=/tmp/shadow:$PATH ', 'SHELLOPTS=xtrace ', 'HOME=/tmp/elsewhere ',
                           'export HOME=/tmp/elsewhere; ', 'ROBOB_REPO_PREVIOUS_BASH_ENV=/tmp/preload.sh ',
                           'ROBOB_REPO_NODE_HELPER=/tmp/helper ', 'ROBOB_REPO_NODE_PYTHON=/tmp/python ',
                           'NVM_DIR=/tmp/nvm ', '_repo_node_added_node=/usr/bin ', 'unset HOME; ', 'env -u HOME '):
                for wrapper in ('', 'offbox run -- ', 'offbox run --bg -- '):
                    command = prefix + wrapper + 'bash tmp/fixture.sh'
                    with self.subTest(command=command):
                        self.assertEqual(self.classify(command), SCRIPT)
            # A command that rewrites the chain before running the fixture.
            for writer in ("cat > " + str(helper / 'init.sh') + " <<'SH'\n:\nSH\n",
                           "cp /tmp/evil.sh ~/.local/libexec/repo-node-pin/init.sh; ",
                           "cp /tmp/evil.py " + str(home / '.nvm/versions/node/v26.0.0/bin/cat') + "; "):
                with self.subTest(writer=writer):
                    self.assertEqual(self.classify(writer + 'bash tmp/fixture.sh'), SCRIPT)

    def test_inherited_bash_env_refusals(self):
        commands = self.write_plain_subpath_fixture()
        live_read = 'cat "' + LIVE + '"\n'
        refusals = []

        def chain(label, *, init=None, select=None, wrapper=None, environment=None, setup=None):
            refusals.append((label, dict(init=init, select=select, wrapper=wrapper), environment or {}, setup))

        chain('init-live-read', init=live_read)
        real_init = (Path(__file__).resolve().parents[2] / 'local-helpers/libexec/repo-node-pin/init.sh').read_text()
        real_select = (Path(__file__).resolve().parents[2] / 'local-helpers/libexec/repo-node-pin/select.py').read_text()
        reader = lambda home, helper: (home / 'reader.sh').write_text(live_read)
        chain('init-runs-live-reader', init=real_init + 'bash "$HOME/reader.sh"\n', setup=reader)
        chain('init-only-runs-live-reader', init='bash "$HOME/reader.sh"\n', setup=reader)
        chain('init-runs-unresolved', init='bash "$UNRESOLVED"\n')
        chain('init-redefines-mktemp', init='mktemp() { printf "%s\\n" "$HOME"; }\n')
        chain('init-exports-mktemp', init=real_init + 'mktemp() { printf "%s\\n" "$HOME"; }; export -f mktemp\n')
        chain('init-comment-drift', init=real_init + '# reviewed?\n')
        chain('select-runs-live-reader', select='import os, subprocess\nsubprocess.run(["bash", os.environ["HOME"] + "/reader.sh"])\n', setup=reader)
        chain('select-appends-reader', select=real_select + '\nimport os\nos.system("bash $HOME/reader.sh")\n', setup=reader)
        chain('wrapper-whitespace-drift', wrapper=(Path(__file__).resolve().parents[2] / 'local-helpers/libexec/repo-node-pin/bash-env.sh').read_text() + '\n')
        chain('init-split-live-read', init='cat "$HOME/.ro""bob/userdata/state""v2.sqlite"\n')
        chain('select-live-read', select='open(' + repr(LIVE) + ').read()\n')
        chain('init-sources-live-reader', init='. "$HOME/reader.sh"\n',
              setup=lambda home, helper: (home / 'reader.sh').write_text(live_read))
        chain('init-sources-clean-file', init='if true; then source "$HOME/clean.sh"; fi\n',
              setup=lambda home, helper: (home / 'clean.sh').write_text(':\n'))
        chain('init-sources-unresolved', init='. "$UNRESOLVED"\n')
        chain('wrapper-sources-unresolved', wrapper='. "$UNRESOLVED"\n')
        chain('wrapper-extra-source', wrapper=(Path(__file__).resolve().parents[2] / 'local-helpers/libexec/repo-node-pin/bash-env.sh').read_text() + '. "$HOME/x.sh"\n')
        chain('wrapper-live-read', wrapper=live_read)
        chain('previous-bash-env-live', environment={'ROBOB_REPO_PREVIOUS_BASH_ENV': '{home}/previous.sh'},
              setup=lambda home, helper: (home / 'previous.sh').write_text(live_read))
        chain('previous-bash-env-clean', environment={'ROBOB_REPO_PREVIOUS_BASH_ENV': '{home}/previous.sh'},
              setup=lambda home, helper: (home / 'previous.sh').write_text(':\n'))
        chain('bash-env-missing', setup=lambda home, helper: (helper / 'bash-env.sh').unlink())
        chain('bash-env-directory', setup=lambda home, helper: ((helper / 'bash-env.sh').unlink(), (helper / 'bash-env.sh').mkdir()))
        chain('init-missing', setup=lambda home, helper: (helper / 'init.sh').unlink())
        chain('select-missing', setup=lambda home, helper: (helper / 'select.py').unlink())
        if os.geteuid() != 0:
            chain('bash-env-unreadable', setup=lambda home, helper: (helper / 'bash-env.sh').chmod(0))
        chain('bash-env-elsewhere', environment={'BASH_ENV': '{home}/bash-env.sh'},
              setup=lambda home, helper: (home / 'bash-env.sh').write_text((helper / 'bash-env.sh').read_text()))
        chain('bash-env-unexpanded', environment={'BASH_ENV': '$HOME/.local/libexec/repo-node-pin/bash-env.sh'})
        chain('bash-env-relative', environment={'BASH_ENV': 'home/.local/libexec/repo-node-pin/bash-env.sh'})
        chain('node-helper-elsewhere', environment={'ROBOB_REPO_NODE_HELPER': '{home}'})
        chain('node-python-elsewhere', environment={'ROBOB_REPO_NODE_PYTHON': '/tmp/python3'})
        chain('nvm-shadows-cat', setup=lambda home, helper: (home / '.nvm/versions/node/v26.0.0/bin/cat').write_text(''))
        chain('nvm-dir-shadows-mktemp', environment={'NVM_DIR': '{home}/other-nvm'},
              setup=lambda home, helper: ((home / 'other-nvm/versions/node/v1.0.0/bin').mkdir(parents=True),
                                          (home / 'other-nvm/versions/node/v1.0.0/bin/mktemp').write_text('')))
        chain('pnpm-bin-shadows-rm', setup=lambda home, helper: (helper / 'pnpm-bin/rm').write_text(''))
        chain('added-node-shadows-cp', environment={'_repo_node_added_node': '{home}/added'},
              setup=lambda home, helper: ((home / 'added').mkdir(), (home / 'added/cp').write_text('')))
        chain('managed-dir-shadows-cat', setup=lambda home, helper: ((home / '.local/share/quint-guard/bin').mkdir(parents=True),
                                                                      (home / '.local/share/quint-guard/bin/cat').write_text('')))
        chain('helper-module-hijack', setup=lambda home, helper: (helper / 'json.py').write_text(''))
        chain('helper-package-hijack', setup=lambda home, helper: ((helper / 're').mkdir(), (helper / 're/__init__.py').write_text('')))
        chain('python-startup', environment={'PYTHONPATH': '/tmp'})
        chain('env-also-set', environment={'ENV': '/tmp/preload.sh'})
        chain('zdotdir-set', environment={'ZDOTDIR': '/tmp'})
        chain('exported-function', environment={'BASH_FUNC_cd%%': '() { :; }'})
        for label, files, extra, setup in refusals:
            shutil_root = self.root / 'home'
            if shutil_root.exists():
                for path in sorted(shutil_root.rglob('*'), reverse=True):
                    path.chmod(0o700) if path.is_dir() else path.chmod(0o600)
                    path.rmdir() if path.is_dir() and not path.is_symlink() else path.unlink()
            home, helper, environment = self.repo_node_pin(**files)
            if setup:
                setup(home, helper)
            environment.update({name: value.replace('{home}', str(home)) for name, value in extra.items()})
            with patch.dict(os.environ, environment):
                for command in commands:
                    with self.subTest(case=label, command=command):
                        self.assertEqual(self.classify(command), SCRIPT)

    def test_inherited_bash_env_selector_inputs(self):
        # select.py opens these before the script runs (repo files from the
        # cwd up to the repo root, NVM aliases, pnpm package.json files).
        commands = self.write_plain_subpath_fixture()
        home, helper, environment = self.repo_node_pin()
        marker = self.write('marker/.robob/userdata/statev2.sqlite', '{}')
        plain = self.write('marker/plain.json', '{}')
        nvm = home / '.nvm'
        corepack = home / 'corepack'
        environment['COREPACK_HOME'] = str(corepack)
        made = []

        def link(path, target):
            path = Path(path)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(target)
            made.append(path)

        def hard(path, target):
            path = Path(path)
            path.parent.mkdir(parents=True, exist_ok=True)
            os.link(target, path)
            made.append(path)

        def fifo(path):
            os.mkfifo(path)
            made.append(Path(path))

        def regular(path, text='{}'):
            made.append(self.write(path, text) if not os.path.isabs(path) else Path(path))
            if os.path.isabs(path):
                Path(path).parent.mkdir(parents=True, exist_ok=True)
                Path(path).write_text(text)

        pnpm_root = home / 'pnpm-install/lib/node_modules/pnpm'
        rows = [
            ('cwd-package-json-live', lambda: link(self.root / 'package.json', marker), SCRIPT),
            ('cwd-nvmrc-live', lambda: link(self.root / '.nvmrc', marker), SCRIPT),
            ('cwd-node-version-live', lambda: link(self.root / '.node-version', marker), SCRIPT),
            ('cwd-pnpm-lock-live', lambda: link(self.root / 'pnpm-lock.yaml', marker), SCRIPT),
            ('script-dir-package-json-live', lambda: link(self.root / 'tmp/package.json', marker), None),
            ('cwd-package-json-dangling-live', lambda: link(self.root / 'package.json', str(marker) + '-wal'), SCRIPT),
            ('cwd-package-json-hard-link', lambda: hard(self.root / 'package.json', marker), SCRIPT),
            ('cwd-package-json-fifo', lambda: fifo(self.root / 'package.json'), SCRIPT),
            ('nvm-alias-live', lambda: link(nvm / 'alias/default', marker), SCRIPT),
            ('nvm-pnpm-package-live', lambda: link(nvm / 'versions/node/v26.0.0/lib/node_modules/pnpm/package.json', marker), SCRIPT),
            ('corepack-package-live', lambda: link(corepack / 'v1/pnpm/10.0.0/package.json', marker), SCRIPT),
            ('path-pnpm-root-package-live', lambda: (regular(str(pnpm_root / 'bin/pnpm.cjs'), ''),
                                                    link(home / '.local/share/quint-guard/bin/pnpm', pnpm_root / 'bin/pnpm.cjs'),
                                                    link(pnpm_root / 'package.json', marker)), SCRIPT),
            ('cwd-package-json-regular', lambda: regular('package.json'), None),
            ('cwd-package-json-plain-link', lambda: link(self.root / 'package.json', plain), None),
            ('nvm-alias-directory', lambda: (nvm / 'alias/lts').mkdir(parents=True, exist_ok=True), None),
        ]
        for label, setup, expected in rows:
            setup()
            try:
                with patch.dict(os.environ, environment):
                    for command in commands:
                        with self.subTest(case=label, command=command):
                            self.assertEqual(self.classify(command), expected)
            finally:
                for path in reversed(made):
                    if path.is_symlink() or path.exists():
                        path.unlink()
                made.clear()
        # The selector walks from each cwd (here deep/a/b and its HERE, deep/a)
        # up to the repo root.
        deep = self.root / 'deep/a/b'
        self.write('deep/a/b/fixture.sh', (self.root / 'tmp/fixture.sh').read_text())
        with patch.dict(os.environ, environment):
            self.assertIsNone(guard.classify('bash fixture.sh', str(deep)))
            link(self.root / 'deep/package.json', marker)
            try:
                self.assertEqual(guard.classify('bash fixture.sh', str(deep)), SCRIPT)
                (deep / '.git').mkdir()
                (deep.parent / '.git').mkdir()
                # Repo roots below the link stop both walks before it.
                self.assertIsNone(guard.classify('bash fixture.sh', str(deep)))
            finally:
                made.pop().unlink()
                (deep / '.git').rmdir()
                (deep.parent / '.git').rmdir()
        # The command must not create selector inputs on the way in.
        with patch.dict(os.environ, environment):
            for command in ('ln -s x package.json; bash tmp/fixture.sh', 'cp a .nvmrc && bash tmp/fixture.sh',
                            'COREPACK_HOME=/tmp/c bash tmp/fixture.sh'):
                with self.subTest(command=command):
                    self.assertEqual(self.classify(command), SCRIPT)

    def test_inherited_bash_env_selector_inputs_round_two(self):
        commands = self.write_plain_subpath_fixture()
        home, helper, environment = self.repo_node_pin()
        marker = self.write('marker/.robob/userdata/statev2.sqlite', '{}')
        # The pinned cd wrapper refreshes in "$(dirname "$0")/..", the fixture's HERE.
        nested = self.write('nested/tests/fixture.sh', (self.root / 'tmp/fixture.sh').read_text())
        nested_commands = ('bash nested/tests/fixture.sh', '/bin/bash ' + str(nested),
                           'offbox run --bg -- bash nested/tests/fixture.sh')
        with patch.dict(os.environ, environment):
            for command in nested_commands:
                with self.subTest(case='nested-clean', command=command):
                    self.assertIsNone(self.classify(command))
            (self.root / 'nested/.nvmrc').symlink_to(marker)
            try:
                for command in nested_commands:
                    with self.subTest(case='nested-here-nvmrc-live', command=command):
                        self.assertEqual(self.classify(command), SCRIPT)
                # Run from inside the script dir too: HERE is then the cwd's parent.
                with self.subTest(case='nested-here-from-tests'):
                    self.assertEqual(guard.classify('bash fixture.sh', str(self.root / 'nested/tests')), SCRIPT)
            finally:
                (self.root / 'nested/.nvmrc').unlink()
        # select.py uses get(name, default), so empty or relative roots follow the cwd.
        (self.root / 'alias').mkdir()
        (self.root / 'alias/default').symlink_to(marker)
        (self.root / 'rel/alias').mkdir(parents=True)
        (self.root / 'rel/alias/default').symlink_to(marker)
        (self.root / 'v1/pnpm/10.0.0').mkdir(parents=True)
        (self.root / 'v1/pnpm/10.0.0/package.json').symlink_to(marker)
        (self.root / 'rel/v1/pnpm/10.0.0').mkdir(parents=True)
        (self.root / 'rel/v1/pnpm/10.0.0/package.json').symlink_to(marker)
        for name in ('NVM_DIR', 'COREPACK_HOME'):
            for value in ('', 'rel', './rel'):
                with patch.dict(os.environ, {**environment, name: value}):
                    for command in commands:
                        with self.subTest(name=name, value=value, command=command):
                            self.assertEqual(self.classify(command), SCRIPT)
        # Lookups by name still work in a directory that cannot be listed.
        if os.geteuid() != 0:
            alias = home / '.nvm/alias'
            alias.mkdir(parents=True)
            (alias / 'default').symlink_to(marker)
            alias.chmod(0o111)
            try:
                with patch.dict(os.environ, environment):
                    for command in commands:
                        with self.subTest(case='unlistable-alias', command=command):
                            self.assertEqual(self.classify(command), SCRIPT)
            finally:
                alias.chmod(0o755)
            (alias / 'default').unlink()
            (alias / 'default').write_text('v26\n')
            with patch.dict(os.environ, environment):
                for command in commands:
                    with self.subTest(case='listable-alias-clean', command=command):
                        self.assertIsNone(self.classify(command))

    def test_inherited_bash_env_fixture_cwd_changes(self):
        # Each cd refreshes the selector in its target; only the HERE subshell
        # from the starting cwd, without CDPATH or a changed $0, is proven.
        self.write_plain_subpath_fixture()
        original = (self.root / 'tmp/fixture.sh').read_text()
        home, helper, environment = self.repo_node_pin()
        marker = self.write('marker/.robob/userdata/statev2.sqlite', '{}')
        for directory in ('nested/nested', 'elsewhere/nested'):
            (self.root / directory).mkdir(parents=True)
            (self.root / directory / '.nvmrc').symlink_to(marker)
        commands = ('bash nested/tests/fixture.sh', '/bin/bash ' + str(self.root / 'nested/tests/fixture.sh'),
                    'offbox run --bg -- bash nested/tests/fixture.sh')
        here = 'HERE="$(cd "$(dirname "$0")/.." && pwd)"\n'
        rows = [
            ('unchanged', original, {}, None),
            ('unchanged-empty-cdpath', original, {'CDPATH': ''}, None),
            ('extra-top-level-cd', original.replace('set -u\n', 'set -u\ncd "$(dirname "$0")/.."\n', 1), {}, SCRIPT),
            ('repeated-here-cd', original.replace(here, here + 'X="$(cd "$(dirname "$0")/.." && pwd)"\n', 1), {}, SCRIPT),
            ('pushd', original.replace('set -u\n', 'set -u\npushd "$(dirname "$0")/.." >/dev/null\n', 1), {}, SCRIPT),
            ('heredoc-cd', original.replace('src="${@: -2:1}"', 'cd /tmp\nsrc="${@: -2:1}"', 1), {}, SCRIPT),
            ('inherited-cdpath', original, {'CDPATH': str(self.root / 'elsewhere')}, SCRIPT),
            ('fixture-cdpath', original.replace('set -u\n', 'set -u\nCDPATH=' + str(self.root / 'elsewhere') + '\n', 1), {'CDPATH': ''}, SCRIPT),
            ('fixture-exported-cdpath', original.replace('set -u\n', 'set -u\nexport CDPATH=' + str(self.root / 'elsewhere') + '\n', 1), {}, SCRIPT),
            ('fixture-argv0', original.replace('set -u\n', 'set -u\nBASH_ARGV0=' + str(self.root / 'nested/nested/tests/x.sh') + '\n', 1), {}, SCRIPT),
        ]
        # Every other cd form, wherever it sits, and every CDPATH mention.
        for statement in ('cd -', 'f() { cd "$(dirname "$0")/.."; }; f', '( cd "$(dirname "$0")/.." )',
                          'declare CDPATH=' + str(self.root / 'elsewhere'), 'read -r CDPATH < /dev/null'):
            rows.append(('fixture-' + statement, original.replace('set -u\n', 'set -u\n' + statement + '\n', 1), {}, SCRIPT))
        # Bash drops quotes, escapes and continuations from command words.
        for statement in ('c""d "$(dirname "$0")/.."', "c'd' \"$(dirname \"$0\")/..\"", "c''d \"$(dirname \"$0\")/..\"",
                          'c\\d "$(dirname "$0")/.."', 'c\\\nd "$(dirname "$0")/.."', '"cd" "$(dirname "$0")/.."',
                          'pu""shd "$(dirname "$0")/.." >/dev/null', 'CD""PATH=' + str(self.root / 'elsewhere'),
                          'P""WD=' + str(self.root / 'elsewhere'), 'sh""opt -s cdable_vars'):
            rows.append(('fixture-split-' + statement, original.replace('set -u\n', 'set -u\n' + statement + '\n', 1), {}, SCRIPT))
        # Logical cd joins $PWD; physical mode and cdable_vars change targets.
        for statement in ('PWD=' + str(self.root / 'elsewhere'), 'export PWD=' + str(self.root / 'elsewhere'),
                          'OLDPWD=/tmp', 'unset PWD', 'read -r PWD < /dev/null', 'shopt -s cdable_vars',
                          'set -P', 'set -eP', 'set -o physical'):
            rows.append(('fixture-' + statement, original.replace('set -u\n', 'set -u\n' + statement + '\n', 1), {}, SCRIPT))
        for label, source, extra, expected in rows:
            self.assertTrue(label.startswith('unchanged') or source != original or extra, label)
            self.write('nested/tests/fixture.sh', source)
            with patch.dict(os.environ, {**environment, **extra}):
                for command in commands:
                    with self.subTest(case=label, command=command):
                        self.assertEqual(self.classify(command), expected)
        with patch.dict(os.environ, environment):
            for command in ('CDPATH=/tmp bash nested/tests/fixture.sh', 'export CDPATH=/tmp; bash nested/tests/fixture.sh'):
                with self.subTest(command=command):
                    self.assertEqual(self.classify(command), SCRIPT)

    def test_repo_node_pin_hashes_cover_fork_helpers(self):
        # Editing local-helpers' repo-node-pin turns the fixture proof off
        # until the guard reviews and pins the new bytes.
        import hashlib
        source = Path(__file__).resolve().parents[2] / 'local-helpers/libexec/repo-node-pin'
        for part, hashes in guard.REPO_NODE_PIN_HASHES.items():
            with self.subTest(part=part):
                self.assertIn(hashlib.sha256((source / part).read_bytes()).hexdigest(), hashes)

    def test_real_repo_node_pin_bash_env_keeps_fixture_proof(self):
        # Drift in this Mac's installed chain should show up here first.
        helper = Path.home() / '.local/libexec/repo-node-pin'
        if not (helper / 'bash-env.sh').is_file():
            self.skipTest('repo-node-pin is not installed')
        commands = self.write_plain_subpath_fixture()
        environment = {'BASH_ENV': str(helper / 'bash-env.sh'), 'ROBOB_REPO_PREVIOUS_BASH_ENV': '',
                       'ROBOB_REPO_NODE_HELPER': '', 'ROBOB_REPO_NODE_PYTHON': '', 'ZDOTDIR': ''}
        with patch.dict(os.environ, environment):
            for command in commands:
                with self.subTest(command=command):
                    self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))

    def test_mktemp_fixture_plain_subpath_straight_line(self):
        for root in ('$T', '${T}'):
            # Keep a live-root marker so both cases exercise the source fallback.
            source = '# .robob\nT=$(mktemp -d)\ncat "' + root + '/fixture-live/userdata/statev2.sqlite"\n'
            self.write('tmp/fixture.sh', source)
            self.assertIsNone(self.classify('bash tmp/fixture.sh'))
            self.write('tmp/fixture.sh', 'cat "' + root + '/fixture-live/userdata/statev2.sqlite"\n' + source)
            self.assertEqual(self.classify('bash tmp/fixture.sh'), SCRIPT)
            self.write('tmp/fixture.sh', source.replace('"' + root + '/fixture-live/userdata/statev2.sqlite"',
                                                       "'" + root + "/fixture-live/userdata/statev2.sqlite'"))
            for command in ('bash tmp/fixture.sh', '/bin/bash ' + str(self.root / 'tmp/fixture.sh'),
                            'offbox run --bg -- bash tmp/fixture.sh'):
                with self.subTest(root=root, command=command):
                    self.assertEqual(self.classify(command), SCRIPT)

    def test_mktemp_fixture_quoted_traversal_tails(self):
        rows = [('"', separator) for separator in (')', '(', ' ', '\t', '\n', '\r', '\v', '\f', ';', '&', '|', '<', '>')]
        rows += [('', separator) for separator in ('\r', '\v', '\f', '\u00a0', '\u2028')]
        for quote, separator in rows:
            source = ('TOP=$(mktemp -d "${TMPDIR:-/tmp}/fixture.XXXXXX") || exit 1\n'
                      'setup() {\n  T=$(mktemp -d "$TOP/case.XXXXXX")\n'
                      '  mkdir -p "$T/.robob" ' + quote + '$T/fixture/statev2.sqlite' + separator + quote + '\n}\n'
                      'setup fake\ncat ' + quote + '$T/fixture/statev2.sqlite' + separator + '/'
                      + '../' * 32 + '$HOME/.ro""bob/userdata/state""v2.sqlite' + quote + '\n')
            self.write('tmp/fixture.sh', source)
            for command in ('bash tmp/fixture.sh', '/bin/bash ' + str(self.root / 'tmp/fixture.sh'),
                            'offbox run --bg -- bash tmp/fixture.sh'):
                with self.subTest(quote=quote, separator=separator, command=command):
                    self.assertEqual(self.classify(command), SCRIPT)

    def test_mktemp_fixture_tool_identity(self):
        backup = Path(__file__).resolve().parents[3] / 'integrations/memory-system/tests/test_backup_replica.sh'
        self.write('tmp/backup.sh', backup.read_text())
        for label, source, search_path, expected, shell in isolated_source_cases.fixture_tool_cases(self.root):
            self.write('tmp/fixture.sh', source)
            with self.subTest(case=label, path=search_path), patch.dict(os.environ, {'PATH':search_path}):
                self.assertEqual(guard.classify_detail(shell + ' tmp/fixture.sh', str(self.root)), (expected, None))
                if label.startswith('path-'):
                    self.assertEqual(guard.classify_detail(shell + ' tmp/backup.sh', str(self.root)), (expected, None))

    def test_backup_command_shapes_and_edited_copies(self):
        backup = Path(__file__).resolve().parents[3] / 'integrations/memory-system/tests/test_backup_replica.sh'
        commands, variants = isolated_source_cases.backup_cases(self.root, backup.read_text())
        self.write('sibling.sh', 'cat ~/.t3/userdata/statev2.sqlite')
        for variant, source, expected in variants:
            self.write('integrations/memory-system/tests/test_backup_replica.sh', source)
            for shape, command, cwd in commands:
                with self.subTest(variant=variant, shape=shape):
                    self.assertEqual(guard.classify(command, str(cwd)), expected)

    def test_fixture_review_control_corpus(self):
        backup = Path(__file__).resolve().parents[3] / 'integrations/memory-system/tests/test_backup_replica.sh'
        for label, source, expected in isolated_source_cases.setup_control_cases(backup.read_text()):
            self.write('tmp/fixture.sh', source)
            for prefix in ('bash ', 'offbox run -- bash ', 'offbox run --remote --no-fallback -- bash '):
                with self.subTest(case=label, source=source, prefix=prefix):
                    self.assertEqual(self.classify(prefix + 'tmp/fixture.sh'), expected)

    @unittest.skipUnless(Path('/opt/homebrew/opt/sqlite/bin/sqlite3').is_file(), 'requires fixture SQLite CLI')
    def test_safe_sqlite_dump_restore(self):
        command = ['/opt/homebrew/opt/sqlite/bin/sqlite3', '-safe', '-noinit', '--', ':memory:']
        dump = "CREATE TABLE scheduled_tasks(name); INSERT INTO scheduled_tasks VALUES ('it''s 7');\nCREATE TABLE ardud_mission_events(id); INSERT INTO ardud_mission_events VALUES ('m');"
        result = subprocess.run(command + [dump, 'SELECT name FROM scheduled_tasks', 'SELECT id FROM ardud_mission_events'], capture_output=True, text=True)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "it's 7\nm\n", ''))
        fixture = self.write('fixture.sql', 'SELECT 1;')
        for sql in ('.read ' + str(fixture), "SELECT readfile('" + str(fixture) + "');"):
            with self.subTest(sql=sql):
                result = subprocess.run(command + [sql], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertRegex(result.stderr.lower(), 'safe|no such function')

    def test_backup_live_output_redirects(self):
        backup = Path(__file__).resolve().parents[3] / 'integrations/memory-system/tests/test_backup_replica.sh'
        self.write('tmp/fixture.sh', backup.read_text())
        alias = self.root / 'output-alias.sqlite'
        alias.symlink_to(Path.home() / '.robob/userdata/statev2.sqlite')
        for suffix in ('-wal', '-shm'):
            Path(str(alias) + suffix).symlink_to(Path.home() / ('.robob/userdata/statev2.sqlite' + suffix))
        for destination in (str(Path.home() / '.robob/userdata/statev2.sqlite'), '~/.t3/userdata/statev2.sqlite', '$HOME/.robob/userdata/statev2.sqlite', str(alias)):
            for suffix in ('', '-wal', '-shm'):
                for quote in ('', '"', "'"):
                    with self.subTest(destination=destination, suffix=suffix, quote=quote):
                        self.assertIsNotNone(self.classify('bash tmp/fixture.sh > ' + quote + destination + suffix + quote + ' 2>&1'))

    def test_backup_setup_tool_identity(self):
        backup = Path(__file__).resolve().parents[3] / 'integrations/memory-system/tests/test_backup_replica.sh'
        self.write('tmp/fixture.sh', backup.read_text())
        for tool in ('ln', 'cp', 'mkdir', 'rm', 'chmod', 'touch', 'mkfifo'):
            folder = self.root / (tool + '-shadow')
            folder.mkdir()
            helper = self.write(str(folder / tool), '#!/bin/sh\nexit 1\n')
            helper.chmod(0o755)
            with self.subTest(tool=tool), patch.dict(os.environ, {'PATH': str(folder) + ':/usr/bin:/bin'}):
                self.assertEqual(self.classify('bash tmp/fixture.sh'), SCRIPT)
        for name in ('BASH_ENV', 'ENV', 'BASHOPTS', 'SHELLOPTS', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONWARNINGS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'):
            with self.subTest(startup=name), patch.dict(os.environ, {name: '/tmp/unproved-helper'}):
                self.assertEqual(self.classify('bash tmp/fixture.sh'), SCRIPT)

    def test_migration_source_propagation_corpus(self):
        migrate = Path(__file__).resolve().parents[3] / 'apps/server/scripts/migrate-dev-db.ts'
        for label, source, expected in isolated_source_cases.migration_mutations(migrate.read_text()):
            self.write('apps/server/scripts/migrate-dev-db.ts', source)
            with self.subTest(case=label):
                self.assertEqual(self.classify('node apps/server/scripts/migrate-dev-db.ts --source /tmp/copy.sqlite --base-dir /tmp/dev-home'), expected)

    def test_heredoc_data_and_execution(self):
        body = "import hashlib, pathlib, subprocess\n# it's a diff check\nprint('ok')\n"
        self.table([
            (f"cat > tmp/x.py <<'EOF'\n{body}EOF\npython3 tmp/x.py", None),
            (f"cat > tmp/x.py <<'EOF'\n{body}EOF", None),
            (f"cat > x.sh <<'EOF'\nsqlite3 {LIVE}\nEOF", None),
            (f"cat > p.sh <<'EOF'\nsqlite3 {LIVE}\nEOF\nbash p.sh", SCRIPT),
            (f"cat > p.sh <<'EOF'\nsqlite3 {LIVE}\nEOF\noffbox run -- bash p.sh", SCRIPT),
            (f"cat >> p.sh <<'EOF'\nsqlite3 {LIVE}\nEOF\nbash p.sh", SCRIPT),
            (f"tee p.py <<'EOF'\nopen({LIVE!r}).read()\nEOF\npython3 p.py", SCRIPT),
            (f"node - <<'JS'\nrequire('fs').readFileSync({LIVE!r})\nJS", READ),
            ("bash <<'EOF'\npython3 $X\nEOF", UNRESOLVED),
            (f"bash <<EOF\nsqlite3 {LIVE} .tables\nEOF", READ),
            (f"python3 - <<'EOF'\nimport sqlite3; sqlite3.connect({LIVE!r})\nEOF", READ),
            ("cat > p.py <<'EOF'\npython3 $X", UNRESOLVED),
            ("cat <<-EOF\n\tpython3 $X\n\tEOF", None),
            ("cat <<A <<'B'\npython3 $X\nA\nbash $Y\nB", None),
            ("cat <<'A' > tmp/a; cat <<'B' > tmp/b\npython3 $X\nA\nbash $Y\nB", None),
            (f"cat <<A > p.txt; bash <<A\nprint('safe')\nA\nsqlite3 {LIVE}\nA", READ),
            (f"bash <<A; cat <<A > p.txt\nsqlite3 {LIVE}\nA\nprint('safe')\nA", READ),
            (f"cat > p.txt <<EOF\n$(sqlite3 {LIVE} .tables)\nEOF", READ),
            (f"cat > p.txt <<EOF\n`sqlite3 {LIVE} .tables`\nEOF", READ),
            (f"cat > p.txt <<'EOF'\n$(sqlite3 {LIVE} .tables)\nEOF", None),
            ("cat > p.py <<PY-SCRIPT\nprint('safe')\nPY-SCRIPT\npython3 p.py", None),
            ("cat > p.py <<EOF_1.2\nprint('safe')\nEOF_1.2\npython3 p.py", None),
            (f"python3 tmp/t.py <<'TXT'\n{LIVE}\nTXT", None),
            (f"python3 -u tmp/t.py <<'TXT'\n{LIVE}\nTXT", None),
            (f"python3 -X dev - <<'PY'\nopen({LIVE!r}).read()\nPY", READ),
            (f"python3 -W ignore - <<'PY'\nopen({LIVE!r}).read()\nPY", READ),
            (f"python3 --check-hash-based-pycs always - <<'PY'\nopen({LIVE!r}).read()\nPY", READ),
            (f"python3 -X dev tmp/t.py <<'TXT'\n{LIVE}\nTXT", None),
        ])
        overwrite = f"cat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\npython3 tmp/live.py"
        self.assertIsNone(self.classify(overwrite))
        self.assertEqual(self.classify(overwrite.replace("> tmp/live.py", ">> tmp/live.py")), SCRIPT)
        self.assertIsNone(self.classify(f"cat > p.py <<'A'\nopen({LIVE!r})\nA\ncat > p.py <<'B'\nprint('safe')\nB\npython3 p.py"))
        for start, end in [("if false; then", "fi"), ("while false; do", "done"), ("for f in a b; do", "done"), ("if false; then bash <<'SH'", "SH\nfi"), ("if false; then {", "}; fi"), ("false && {", "}"), ("true || (", ")")]:
            with self.subTest(start=start):
                self.assertEqual(self.classify(f"{start}\ncat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\n{end}\npython3 tmp/live.py"), SCRIPT)
        for prefix in ("false && ", "true || "):
            self.assertEqual(self.classify(f"{prefix}cat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\npython3 tmp/live.py"), SCRIPT)
        for start, end in [("{", "} &"), ("(", ") &"), ("{", "} | cat"), ("{", "} >/dev/null &"), ("(", ") 2>/dev/null &"), ("{", "} >/dev/null 2>&1 &"), ("{", "} &>/dev/null &"), ("{", "} >/dev/null | cat")]:
            self.assertEqual(self.classify(f"{start}\ncat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\n{end}\npython3 tmp/live.py"), SCRIPT)
        for start, end in [("{", "}"), ("(", ")"), ("{", "} >/dev/null"), ("{", "} >/dev/null 2>&1")]:
            self.assertIsNone(self.classify(f"{start}\ncat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\n{end}\npython3 tmp/live.py"))
        for target in ("'&'", "'|'", "'&>'", "'&&'", "'&&&'", "'>'", "'&''>'", "\"|\"", "'a&b'", "'__guard_quoted_0__'", "'<<'", "'>>'"):
            for end, expected in [(" &", SCRIPT), (" | cat", SCRIPT), ("", None)]:
                with self.subTest(target=target, end=end):
                    command = f"# it's a quoted target\n{{\ncat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\n}} > {target}{end}\npython3 tmp/live.py"
                    self.assertEqual(self.classify(command), expected)

    def test_python_prose_and_source_edits(self):
        prose = "import subprocess\nt=\"\"\"- node --test --test-name-pattern='x y' scripts/a.mjs\n- python3 $X\n- bash \\\"$Y\\\"\"\"\"\nopen('tmp/n.md','w').write(t)"
        edit = 'from pathlib import Path\np=Path("x.py"); p.write_text(p.read_text().replace("~/.robob/userdata/statev2.sqlite","~/.robob/userdata/replica.sqlite"))'
        self.table([
            ("python3 - <<'PY'\n" + prose + "\nPY", None),
            ("python3 - <<'PY'\n" + edit + "\nPY", None),
            ("python3 -c " + shlex.quote(edit), None),
            ("python3 tmp/edit.py", None),
            ("python3 - <<'PY'\nfrom pathlib import Path\np=Path('tmp/e.py'); p.write_text(p.read_text().replace(\"it's\", 'its'))\nPY\npython3 tmp/e.py", None),
        ])
        self.write("tmp/edit.py", edit)
        self.assertIsNone(self.classify("python3 tmp/edit.py"))
        denied = [
            f'from pathlib import Path; Path({LIVE!r}).read_bytes()',
            f'import shutil; shutil.copy({LIVE!r}, "/tmp/c")',
            f'import os; p=os.environ["P"]; open(p).read(); s={LIVE!r}',
            f'import sqlite3; sqlite3.connect({LIVE!r})',
            f'import sqlite3 as s; s.connect({LIVE!r})',
            f'from shutil import copy as c; c({LIVE!r}, "/tmp/c")',
            f'p={LIVE!r}; open(p).read()',
            f'from pathlib import Path; p=Path({LIVE!r}); p.read_bytes()',
            f'p="tmp/a"; p=input(); open(p); s={LIVE!r}',
            f'open(input()); s={LIVE!r}',
            f'reader=open; reader({LIVE!r}).read()',
            f'import shutil; copy=shutil.copyfile; copy({LIVE!r}, "/tmp/c")',
            f'from pathlib import Path; reader=Path({LIVE!r}).read_bytes; reader()',
            'import os; p=os.path.join(os.environ["HOME"], ".robob", "userdata", "statev2.sqlite"); open(p).read()',
            'import os; os.chdir("/Users/x/.local/share/opencode"); open("opencode.db").read()',
            'from os import chdir; chdir("/Users/x/.robob/userdata"); open("statev2.sqlite-wal").read()',
            f'open({LIVE!r}',
            'from pathlib import Path; p=Path.home()/".robob"/"userdata"/"statev2.sqlite"; p.read_bytes()',
            'import os; p=os.path.join(os.path.expanduser("~"), ".local/share/opencode", "opencode.db"); open(p)',
        ]
        for source in denied:
            with self.subTest(source=source):
                self.assertEqual(self.classify("python3 -c " + shlex.quote(source)), READ)
        for suffix in ("", "-wal", "-shm", "-journal"):
            self.assertEqual(self.classify("python3 -c " + shlex.quote(f"open({(LIVE + suffix)!r}).read()")), READ)

    def test_fixture_db_names_are_not_live_paths(self):
        source = 'from pathlib import Path\nimport tempfile\nwith tempfile.TemporaryDirectory() as tmp:\n p=Path(tmp)/"statev2.sqlite"\n p.write_text("userdata")\n s="opencode"\n q=Path(tmp)/"opencode.db"\n'
        self.assertFalse(guard.source_touches_live(source))
        self.assertIsNone(self.classify("python3 - <<'PY'\n" + source + "\nPY"))
        self.table([
            ("grep -n -E 'userdata|.robob|statev2.sqlite|opencode.db' repo.py", None),
            ("git show abc:path.py | grep -n -E 'userdata|statev2.sqlite|opencode.db'", None),
            (f"cat > mod.py <<'PY'\nimport sqlite3; sqlite3.connect({LIVE!r})\nPY\npython3 -m mod", SCRIPT),
            (f"cat > tests/mod.py <<'PY'\nimport sqlite3; sqlite3.connect({LIVE!r})\nPY\npython3 -m unittest tests.mod", SCRIPT),
            (f"cat > pkg/__main__.py <<'PY'\nopen({LIVE!r}).read()\nPY\npython3 -m pkg", SCRIPT),
            (f"cat > pkg/__init__.py <<'PY'\nopen({LIVE!r}).read()\nPY\npython3 -m pkg", SCRIPT),
            (f"cat > tests/test_live.py <<'PY'\nopen({LIVE!r}).read()\nPY\npython3 -m unittest discover -s tests", SCRIPT),
            (f"cat > tests/test_live.py <<'PY'\nopen({LIVE!r}).read()\nPY\npython3 -m unittest tests/test_live.py", SCRIPT),
        ])
        for name in ("opencode.db", "opencode.db-wal", "opencode.db-shm", "opencode.db-journal"):
            self.assertEqual(guard.classify("python3 -c " + shlex.quote(f"open({name!r}).read()"), "/Users/x/.local/share/opencode"), READ)
        node = "const fs=require('fs'),path=require('path'),os=require('os'); fs.readFileSync(path.join(os.homedir(),'.robob','userdata','statev2.sqlite'));"
        self.assertEqual(self.classify("node -e " + shlex.quote(node)), READ)

    def test_filters(self):
        self.table([(command, None) for command in [
            "diff -u a.txt b.txt; rg --files -g 'watchers.json' -g '!*statev2.sqlite*' -g '!*opencode.db*' ~/.local/share/robob-watch",
            "rg --files -g '*.json' -g '*.md' -g '!*statev2.sqlite*' -g '!*opencode.db*' .",
            "rg --files --glob='!statev2.sqlite*' ~/.robob",
            "rg --files -g '*statev2.sqlite*' ~/.robob",
            "rg foo -g '!statev2.sqlite*' .",
            "grep -rn foo --exclude='statev2.sqlite*' .",
            "find . -name '*.md' -not -name 'statev2.sqlite*'",
            "find . -name 'statev2.sqlite'",
            "fd -E 'opencode.db*' -e json",
            "fd '*opencode.db*' .",
            "git ls-files -x '*statev2.sqlite*'",
            "rg --files --iglob='*statev2.sqlite*' . | cat",
            "rg --files --glob '*opencode.db*' .",
            "rg --files ~/.robob/userdata/statev2.sqlite",
            "fd -g '*.md' ~/.robob/userdata/statev2.sqlite",
            "find . ! -iname 'statev2.sqlite*' -exec cat {} +",
            "grep foo --exclude-dir='statev2.sqlite*' .",
            "rg foo -g '*statev2.sqlite*' ./fixtures",
        ]] + [(command, READ) for command in [
            "rg foo -g '*statev2.sqlite*' ~/.robob/userdata",
            "grep -r foo --include='*statev2*' ~/.robob",
            "find ~/.robob/userdata -name 'statev2.sqlite' -exec cat {} +",
            "diff a.txt b.txt; sqlite3 ~/.robob/userdata/statev2.sqlite .tables",
            "grep x ~/.robob/userdata/statev2.sqlite",
            "rg foo -g statev2.sqlite ~/.robob/userdata",
            "fd -g '*statev2.sqlite*' ~/.robob -x cat",
            "fd '*statev2.sqlite*' ~/.robob --exec cat",
            "fd -g '*opencode.db*' ~/.local/share/opencode -X cat",
        ]])

    def test_live_shell_assignments_still_block_readers(self):
        for reader in ("sqlite3", "cat"):
            for assignment in (f"DB={LIVE};", f"export DB={LIVE};", f"readonly DB={LIVE};", f"env DB={LIVE}"):
                command = f'{assignment} {reader} "$DB"'
                with self.subTest(command=command):
                    self.assertEqual(self.classify(command), READ)
        self.table([
            (f'DB={LIVE}; cat "${{DB}}"', READ),
            (f'DB={LIVE}; COPY=$DB; cat "$COPY"', READ),
            ('ROOT=/Users/x/.robob/userdata; DB=$ROOT/statev2.sqlite; cat "$DB"', READ),
            ('ROOT=/Users/x/.robob/userdata; cat "$ROOT/statev2.sqlite"', READ),
            (f'env DB={LIVE} python3 -c \'import os,sqlite3; sqlite3.connect(os.environ["DB"])\'', READ),
            (f'DB={LIVE}; env DB=/tmp/safe cat "$DB"', READ),
            (f'if false; then DB={LIVE}; fi; cat "$DB"', READ),
            ('ROOT=/Users/x/.robob/userdata; if false; then ROOT=/tmp; fi; cat "$ROOT/statev2.sqlite"', READ),
            ('ROOT=/Users/x/.robob/worktrees; ROOT=/Users/x/.robob/userdata; cat "$ROOT/statev2.sqlite"', READ),
            ('ROOT=/Users/x/.robob/userdata; ROOT=/Users/x/.local/share/opencode; cat "$ROOT/opencode.db"', READ),
            (f'env -S \'DB={LIVE} cat "$DB"\'', READ),
            ('DB=/tmp/isolated.sqlite; cat "$DB"', None),
            (f'DB={LIVE}; echo "$DB"', None),
            (f'cat > note.txt <<\'EOF\'\nDB={LIVE}; cat "$DB"\nEOF', None),
        ])
        for operator in (":-", "-", ":=", "=", ":+", "+", ":?", "?"):
            for default in (LIVE, shlex.quote(LIVE), '"' + LIVE + '"', "${Y:-" + LIVE + "}"):
                command = "DB=${X" + operator + default + '}; cat "$DB"'
                with self.subTest(operator=operator, default=default):
                    self.assertEqual(self.classify(command), READ)
        self.assertIsNone(self.classify('DB=${X:-"}"}; cat tmp/t.py'))
        self.assertIsNone(self.classify('DB=${X:-${Y:-/tmp/safe}}; cat "$DB"'))
        self.assertEqual(self.classify('python3 ${SCRIPT:-tmp/t.py}'), UNRESOLVED)
        for substitution, expected in [
            (f"$(cat {LIVE})", READ),
            (f"`cat {LIVE}`", READ),
            ("$(python3 tmp/live.py)", SCRIPT),
            ("$(python3 $SCRIPT)", UNRESOLVED),
            ("$(git status --short)", None),
        ]:
            for quote in ("", '"'):
                value = "${X:-" + quote + substitution + quote + "}"
                self.table([(f"OUT={value}", expected), (f"jq --arg x {value} . facts.json", expected)])
            value = "${X:-'" + substitution + "'}"
            self.table([(f"OUT={value}", None), (f"jq --arg x {value} . facts.json", None)])
        for command in ("OUT=${X:-$(cat statev2.sqlite)}", "jq --arg x ${X:-$(cat statev2.sqlite)} . facts.json"):
            self.assertEqual(self.classify("cd /Users/x/.robob/userdata && " + command), READ)
        self.write("check.py", f"open({LIVE!r}).read()")
        nested = self.write("sub/check.py", "print('safe')")
        command = "cd sub && OUT=${X:-$(python3 check.py)}"
        self.assertIsNone(self.classify(command))
        self.write("check.py", "print('safe')")
        nested.write_text(f"open({LIVE!r}).read()")
        self.assertEqual(self.classify(command), SCRIPT)

    def test_parameter_substitutions_in_headers(self):
        forms = [
            ("for item in", "; do :; done"),
            ("select item in", "; do break; done"),
            ("case", " in *) :;; esac"),
            ("case item in", ") :;; esac"),
            ("case item in other|", ") :;; esac"),
        ]
        for prefix, suffix in forms:
            with self.subTest(header=prefix):
                command = f"cd /Users/x/.robob/userdata && {prefix} ${{X:-$(cat statev2.sqlite)}}{suffix}"
                self.assertEqual(self.classify(command), READ)
                self.assertIsNone(self.classify(f"{prefix} ${{X:-$(git status --short)}}{suffix}"))
                self.assertIsNone(self.classify(f"{prefix} ${{X:-'$(python3 $SCRIPT)'}}{suffix}"))
                self.assertIsNone(self.classify(f"{prefix} {LIVE}{suffix}"))
        self.assertIsNone(self.classify("for item in ${X:-$(python3 tmp/t.py)}; do cd tmp; done"))
        for pattern in (
            "${X:-$(cat statev2.sqlite)}", "${X:-$(cat statev2.sqlite)}|other",
            "other|${X:-$(cat statev2.sqlite)}", "one|${X:-$(cat statev2.sqlite)}|other",
        ):
            for earlier_arm in ("", "first) cd /tmp;; "):
                command = f"cd /Users/x/.robob/userdata && case item in {earlier_arm}{pattern}) :;; esac"
                with self.subTest(pattern=pattern, earlier_arm=earlier_arm):
                    self.assertEqual(self.classify(command), READ)
                    self.assertIsNone(self.classify(command.replace("$(cat statev2.sqlite)", "$(git status --short)")))
        self.assertIsNone(self.classify("case item in one) cd /tmp;; two) cat tmp/t.py | head -1;; esac"))

    def test_ordinary_substitutions_in_headers(self):
        forms = [("for x in", '; do echo "$x"; done'), ("select x in", "; do break; done"),
                 ("case", " in *) :;; esac"), ("case x in", ") :;; esac"),
                 ("case x in first) cd /tmp;;", "|other) :;; esac")]
        for prefix, suffix in forms:
            for substitution in (f"$(cat {LIVE})", f"`cat {LIVE}`", '$(cat "' + LIVE + '")'):
                for quote in ("", '"'):
                    with self.subTest(form=prefix, substitution=substitution, quote=quote):
                        self.assertEqual(self.classify(f"{prefix} {quote}{substitution}{quote}{suffix}"), READ)
                self.assertIsNone(self.classify(f"{prefix} '{substitution}'{suffix}"))
            for value in ("$(git status --short)", "`git status --short`", r"\$(python3 tmp/live.py)"):
                self.assertIsNone(self.classify(f"{prefix} {value}{suffix}"))
            self.assertEqual(self.classify(f"cd /Users/x/.robob/userdata && {prefix} $(cat statev2.sqlite){suffix}"), READ)
        self.assertIsNone(self.classify("cat > note.md <<'EOF'\nfor x in $(python3 $X); do :; done\nEOF"))
        self.assertEqual(self.classify(f"for x in $(python3 - <<'PY'\nopen({LIVE!r}).read()\nPY\n); do :; done"), READ)
        self.assertIsNone(self.classify(f"for x in $(cat <<'TXT'\n{LIVE}\nTXT\n); do :; done"))
        self.assertEqual(self.classify(f"for x in ${{X:- # $(cat {LIVE})}}; do :; done"), READ)
        self.assertIsNone(self.classify(f"# $(cat {LIVE})\nfor x in $(git status --short); do :; done"))
        for body in ("# )\nprint('safe')", "# it's a ) comment\nprint('safe')"):
            command = 'result="$(python3 - <<\'PY\'\n' + body + '\nPY\n)"'
            self.assertIsNone(self.classify(command))
            self.assertEqual(self.classify(command.replace("print('safe')", f"open({LIVE!r}).read()")), READ)
        for body in (")", "it's $(python3 $X)", "for x in a; do ( : ); done"):
            command = 'result="$(cat <<\'TEXT\'\n' + body + '\nTEXT\n)"'
            self.assertIsNone(self.classify(command))

    def test_isolated_userdata_paths(self):
        paths = ["/var/folders/x/T/sync-smoke-639-ab/fixture/userdata/statev2.sqlite",
                 str(self.root / ".t3/userdata/statev2.sqlite"), "fixture/userdata/statev2.sqlite"]
        for path in paths:
            with self.subTest(path=path):
                self.assertIsNone(self.classify(f"sqlite3 {path} 'SELECT count(*) FROM threads'"))
                self.assertIsNone(self.classify("python3 -c " + shlex.quote(f"import sqlite3; sqlite3.connect({path!r})")))
                self.assertIsNone(self.classify("node -e " + shlex.quote(f"require('fs').readFileSync({path!r})")))
                self.assertIsNone(self.classify("python3 -c " + shlex.quote(f"import os; os.chdir('fixture/userdata'); open('statev2.sqlite').read()")))
        fake_live = self.write("home/.robob/userdata/statev2.sqlite", "fixture")
        alias = self.root / "fixture-alias.sqlite"
        alias.symlink_to(fake_live)
        with patch.object(Path, "open", side_effect=AssertionError("must not read DB symlink")):
            self.assertEqual(self.classify(f"sqlite3 {alias} .tables"), READ)
        self.table([(f"sqlite3 {LIVE} .tables", READ), ("sqlite3 ~/.robob/userdata/statev2.sqlite .tables", READ),
                    ('sqlite3 "$HOME/.robob/userdata/statev2.sqlite" .tables', READ),
                    ('ROOT=$HOME/.robob/userdata; sqlite3 "$ROOT/statev2.sqlite" .tables', READ)])
        for cwd, target in (("/Users/x/.robob", "userdata"), ("/Users/x/.robob/worktrees", "../userdata")):
            for source, interpreter in [
                (f"import os; os.chdir({target!r}); open('statev2.sqlite').read()", "python3 -c "),
                (f"process.chdir({target!r}); require('fs').readFileSync('statev2.sqlite')", "node -e "),
            ]:
                with self.subTest(cwd=cwd, source=source):
                    self.assertEqual(guard.classify(interpreter + shlex.quote(source), cwd), READ)

    def test_node_isolated_paths_inside_robob_workspaces(self):
        workspace = "/Users/x/.robob/worktrees/project/review"
        for basename in ("statev2.sqlite", "opencode.db"):
            for suffix in ("", "-wal", "-shm", "-journal"):
                for folder in (".t3/userdata", "tmp/fixture/userdata"):
                    target = f"{workspace}/{folder}/{basename}{suffix}"
                    for quote in ("'", '"'):
                        with self.subTest(target=target, quote=quote):
                            command = "node -e " + shlex.quote(f"require('fs').readFileSync({quote}{target}{quote})")
                            self.assertIsNone(guard.classify(command, workspace))
        live = self.write("home/.robob/userdata/statev2.sqlite", "fixture")
        alias = self.root / "copy/userdata/statev2.sqlite"
        alias.parent.mkdir(parents=True)
        alias.symlink_to(live)
        opencode = self.write("home/.local/share/opencode/opencode.db", "fixture")
        oc_alias = self.root / "copy/opencode.db"
        oc_alias.symlink_to(opencode)
        rows = [
            (f"require('fs').readFileSync({LIVE!r})", workspace),
            ("require('fs').readFileSync('../userdata/statev2.sqlite')", "/Users/x/.robob/worktrees"),
            ("require('fs').readFileSync('opencode.db')", "/Users/x/.local/share/opencode"),
            ("process.chdir('/Users/x/.robob'); require('fs').readFileSync('userdata/statev2.sqlite')", workspace),
            ("process.chdir('/Users/x/.local/share'); require('fs').readFileSync('opencode/opencode.db')", workspace),
            (f"require('fs').readFileSync({str(alias)!r})", workspace),
            (f"require('fs').readFileSync({str(oc_alias)!r})", workspace),
            ("require('fs').readFileSync(path.join(os.homedir(), '.robob', 'userdata', 'statev2.sqlite'))", workspace),
            ("require('fs').readFileSync(path.join(os.homedir(), '.robob', 'userdata/statev2.sqlite'))", workspace),
            ("require('fs').readFileSync(path.join(os.homedir(), '.local/share/opencode', 'opencode.db'))", workspace),
            (f"require('fs').readFileSync(path.join('{workspace}/tmp/fixture/userdata/statev2.sqlite', '../../../../../../../userdata/statev2.sqlite'))", workspace),
            ("const p = root + '/userdata/statev2.sqlite'; const root = '.robob'; require('fs').readFileSync(p)", workspace),
        ]
        with patch.object(Path, "open", side_effect=AssertionError("must not open DB")):
            for source, cwd in rows:
                with self.subTest(source=source, cwd=cwd):
                    self.assertEqual(guard.classify("node -e " + shlex.quote(source), cwd), READ)
        paths = [
            (f"{workspace}/.t3/userdata/statev2.sqlite", "/worktrees/project/review/.t3"),
            ("/Users/x/.local/share/fixture/opencode/opencode.db", "/fixture"),
        ]
        for target, removed in paths:
            for reader in ("readFileSync", "readFile", "openSync", "open", "createReadStream"):
                with self.subTest(target=target, reader=reader):
                    self.assertIsNone(guard.classify("node -e " + shlex.quote(f"require('fs').{reader}({target!r})"), workspace))
            for expression in (
                f"{target!r}.replace({removed!r}, '')",
                f"{target!r} .replaceAll({removed!r}, '')",
                f"{target!r} /* path transform */ .replace({removed!r}, '')",
                f"{target!r}['replace']({removed!r}, '')",
                f"{target!r}.split({removed!r}).join('')",
                f"normalize({target!r})",
                f"{target!r} + '/../../userdata/statev2.sqlite'",
            ):
                with self.subTest(expression=expression):
                    self.assertEqual(guard.classify("node -e " + shlex.quote(f"require('fs').readFileSync({expression})"), workspace), READ)
            bound = f"const p={target!r}; require('fs').readFileSync(p.replace({removed!r}, ''))"
            self.assertEqual(guard.classify("node -e " + shlex.quote(bound), workspace), READ)

    def test_dynamic_python_imports_cannot_get_text_only_exemption(self):
        bodies = [
            f'__import__("sqlite3").connect({LIVE!r})',
            f'import builtins; builtins.__import__("sqlite3").connect({LIVE!r})',
            f'import importlib; importlib.import_module("sqlite3").connect({LIVE!r})',
            f'from importlib import import_module as load; load("sqlite3").connect({LIVE!r})',
            f'load=__import__; load("sqlite3").connect({LIVE!r})',
            f'getattr(__builtins__, "__import__")("sqlite3").connect({LIVE!r})',
            f'import builtins; load=getattr(builtins, "__import__"); load("sqlite3").connect({LIVE!r})',
            f'import importlib; loader=importlib; loader.import_module("sqlite3").connect({LIVE!r})',
            f'import builtins; loader=builtins; loader.__import__("sqlite3").connect({LIVE!r})',
            f'from builtins import open as reader; reader({LIVE!r}).read()',
        ]
        for body in bodies:
            self.table([
                ("python3 -c " + shlex.quote(body), READ),
                (f"python3 - <<'PY'\n{body}\nPY", READ),
                (f"cat > dynamic.py <<'PY'\n{body}\nPY\npython3 dynamic.py", SCRIPT),
            ])
        self.assertIsNone(self.classify("python3 -c " + shlex.quote(f'print({LIVE!r}, "__import__(sqlite3)")')))
        self.assertIsNone(self.classify("python3 -c '__import__(\"subprocess\").run([\"git\", \"status\"])'"))

    def test_plain_argv_database_mentions_are_data(self):
        for text in ("statev2.sqlite", "opencode.db", LIVE, f"Use python3 instead of sqlite3 {LIVE}"):
            with self.subTest(text=text):
                self.assertIsNone(self.classify("jq --arg new " + shlex.quote(text) + " '.text=$new' facts.json"))
        self.assertIsNone(self.classify("jq --argjson new " + shlex.quote(json.dumps(LIVE)) + " '.text=$new' facts.json"))
        self.assertEqual(self.classify(f"jq . {LIVE}"), READ)
        self.assertEqual(self.classify(f"jq --rawfile new {LIVE} . facts.json"), READ)
        for flags in ("-n", "-nc", "--null-input", "--indent 2 -n"):
            with self.subTest(flags=flags):
                self.assertIsNone(self.classify(f"jq {flags} " + shlex.quote(json.dumps(LIVE))))
        self.assertIsNone(self.classify(f"jq -n --args '$ARGS.positional' {LIVE}"))
        self.assertIsNone(self.classify("jq -n --jsonargs '$ARGS.positional' " + shlex.quote(json.dumps(LIVE))))
        self.assertIsNone(self.classify("jq --arg x -f -n " + shlex.quote(json.dumps(LIVE))))
        self.assertIsNone(self.classify(f'DB={LIVE}; jq --arg x "$DB" "." facts.json'))
        self.assertEqual(self.classify(f'DB={LIVE}; jq . "$DB"'), READ)
        for flag in ("--args", "--jsonargs"):
            self.table([
                (f"jq . {LIVE} {flag} value", READ),
                (f"jq {flag} . < {LIVE}", READ),
                (f'DB={LIVE}; jq {flag} . < "$DB"', READ),
                (f"jq {flag} . < tmp/t.py", None),
                (f"jq {flag} . {shlex.quote(json.dumps(LIVE))}", None),
            ])
        for command in (
            f"jq -f {LIVE} facts.json", f"jq --from-file={LIVE} facts.json",
            f"jq --slurpfile data {LIVE} .", f"jq -f filter.jq {LIVE}",
            f"jq -ffilter.jq {LIVE}", f"jq --run-tests {LIVE}",
            f"jq -nf {LIVE}", f"jq --arg x --args . {LIVE}",
            f"jq {shlex.quote(json.dumps(LIVE))} {LIVE}",
        ):
            self.assertEqual(self.classify(command), READ)
        self.assertEqual(self.classify(f"cat {LIVE}"), READ)

    def test_wrappers_scripts_and_symlinks(self):
        self.table([
            ("python3 tmp/live.py", SCRIPT),
            ("offbox run -- python3 tmp/live.py", SCRIPT),
            ("offbox run --size large -- bash -lc 'python3 tmp/live.py'", SCRIPT),
            ("env -C tmp python3 live.py", SCRIPT),
            ("uv run python3 tmp/live.py", SCRIPT),
            ("bash -c 'python3 tmp/live.py'", SCRIPT),
            ("offbox run -- bash -lc 'source ~/.nvm/nvm.sh && nvm use 24 && node --test x.test.mjs'", None),
            ("source ~/.robob/userdata/statev2.sqlite", SCRIPT),
            ("python3 $X", UNRESOLVED),
            ("python3 tmp/t.py", None),
        ])
        self.write("__guard_quoted_0__.py", f"open({LIVE!r}).read()")
        self.assertEqual(self.classify("echo '&'; python3 '__guard_'quoted_0__.py"), SCRIPT)
        self.assertEqual(self.classify("echo '&'; python3 __guard_quoted_0__.py"), SCRIPT)
        self.assertEqual(self.classify("python3 '\0guard_quoted_0__'"), UNRESOLVED)
        alias = self.root / "alias.py"
        alias.symlink_to(LIVE)
        with patch.object(Path, "open", side_effect=AssertionError("must not open DB alias")):
            self.assertIn(self.classify("python3 alias.py"), {READ, SCRIPT})
            self.assertEqual(self.classify("cat alias.py"), READ)

    def test_control_flow(self):
        self.table([
            ("if true; then python3 tmp/t.py; fi", None),
            ('for f in a b; do python3 tmp/t.py "$f"; done; python3 tmp/t.py', None),
            ("while false; do python3 tmp/t.py; done; python3 tmp/t.py", None),
            ("until true; do python3 tmp/t.py; done; python3 tmp/t.py", None),
            ("for f in a b; do echo cd; python3 tmp/t.py; done", None),
            ("case x in x) python3 tmp/t.py;; esac", None),
            ("case x in x) cd sub;; y) python3 tmp/t.py;; esac", None),
            ("if a; then cd sub; else python3 tmp/t.py; fi", None),
            ("if c; then cd sub; fi; python3 t.py", UNRESOLVED),
            ("if c; then { cd sub; }; fi; python3 t.py", UNRESOLVED),
            ("if c; then (cd sub); fi; python3 tmp/t.py", None),
            ("for d in a b; do cd $d; python3 t.py; done", UNRESOLVED),
            ("for d in a b; do python3 tmp/t.py; cd sub; done", UNRESOLVED),
            ("for d in a b; do python3 tmp/t.py; command cd sub; done", UNRESOLVED),
            ("for d in a b; do python3 tmp/t.py; eval 'cd sub'; done", UNRESOLVED),
            ("if true; then python3 tmp/live.py; fi", SCRIPT),
        ])
        self.write("sub/t.py", f"open({LIVE!r}).read()")
        self.assertEqual(self.classify("if cd sub && false; then :; else python3 t.py; fi"), SCRIPT)

    def test_reporter_commands(self):
        fixtures = Path(__file__).with_name("fixtures")
        manifest = json.loads((fixtures / "manifest.json").read_text())
        for filename in manifest:
            if manifest[filename]["kind"] == "codex-code-mode":
                continue
            with self.subTest(fixture=filename):
                command = (fixtures / filename).read_text()
                self.assertIsNone(self.classify(command), guard.classify_detail(command, str(self.root)))

    def test_reporter_workdirs_and_literal_cd(self):
        fixtures = Path(__file__).with_name("fixtures")
        manifest = json.loads((fixtures / "manifest.json").read_text())
        for filename, info in manifest.items():
            if info["kind"] == "codex-code-mode":
                continue
            if info["card"] in {1061, 2037, 3022, 3186, 3207, 162, 2586, 2697, 540, 3122, 358, 2282, 3041, 2808, 1606, 2996, 3070}:
                with self.subTest(fixture=filename, cwd=info["cwd"]):
                    command = (fixtures / filename).read_text()
                    self.assertIsNone(guard.classify(command, info["cwd"]))
        command = (fixtures / "crpko-3186-leading-cd.sh").read_text()
        cwd = "/Volumes/ExternalSSD/crpko-devops/tmp/card-3186/repo"
        paths = guard.scripts_in(command, "/Volumes/ExternalSSD/crpko-devops")
        for name in ("test-aurora-master-rotation-off.mjs", "test-cutover-command-deny-infra.mjs"):
            self.assertIn(Path(os.path.realpath(Path(cwd) / "scripts" / name)), paths)
        for body, expected in [("console.log('safe')", None), (f"require('fs').readFileSync({LIVE!r})", SCRIPT)]:
            script = self.write("clone/scripts/check.mjs", body)
            command = f"cd {script.parents[1]} && git log > log.json && node --test scripts/check.mjs > test.log 2>&1"
            self.assertEqual(self.classify(command), expected)
        self.write("clone/scripts/first.mjs", "console.log('safe')")
        self.assertEqual(self.classify(f"cd {self.root}/clone && node --test scripts/first.mjs scripts/check.mjs > test.log 2>&1"), SCRIPT)

    def test_markdown_2037_does_not_hide_a_later_script(self):
        fixtures = Path(__file__).with_name("fixtures")
        command = (fixtures / "crpko-2037-heredoc-blocker.sh").read_text()
        self.assertEqual(guard.scripts_in(command, str(self.root)), [])
        self.assertEqual(self.classify(command + "\npython3 tmp/live.py"), SCRIPT)

    def test_existing_and_written_script_3022(self):
        fixtures = Path(__file__).with_name("fixtures")
        body = (fixtures / "bodies/crpko-3022-existing-edit.py").read_text()
        script = self.write("tmp/card-3022/edit.py", body)
        self.assertIsNone(self.classify("python3 tmp/card-3022/edit.py"))
        self.assertIsNone(self.classify(f"python3 {script}"))
        script.write_text(f"open({LIVE!r}).read()")
        self.assertEqual(self.classify("python3 tmp/card-3022/edit.py"), SCRIPT)
        self.assertEqual(self.classify(f"python3 {script}"), SCRIPT)
        cwd = "/Users/ardud/checkouts/market-data-registry-3022"
        target = Path(os.path.realpath(Path(cwd) / "tmp/card-3022/edit.py"))
        self.assertEqual(guard.scripts_in("python3 tmp/card-3022/edit.py", cwd), [target])
        command = (fixtures / "crpko-3022-create-run.sh").read_text()
        self.assertIsNone(guard.classify(command, cwd))
        twin = command.replace("\nPY\n", f"\nopen({LIVE!r}).read()\nPY\n", 1)
        self.assertNotEqual(twin, command)
        self.assertEqual(guard.classify(twin, cwd), SCRIPT)

    def test_absolute_script_3207_and_relative_script_162(self):
        fixtures = Path(__file__).with_name("fixtures")
        manifest = json.loads((fixtures / "manifest.json").read_text())
        for name, target in [
            ("crpko-3207-s75-absolute-resolve.sh", "/Users/ardud/checkouts/rewards-nv1-carry/tmp/carry-3207/resolve.py"),
            ("usdtwallet-162-s76-create-relative-python.sh", "tmp/cards/fix-plain-network-errors/write-red.py"),
        ]:
            info = manifest[name]
            body = (fixtures / info["body_fixture"]).read_text()
            command = (fixtures / name).read_text()
            with self.subTest(fixture=name):
                self.assertIsNone(guard.classify(command, info["cwd"]))
                for extra, expected in [("", None), (f"\nopen({LIVE!r}).read()", SCRIPT)]:
                    wrapper = f"cat > {target} <<'GUARD_BODY'\n{body}{extra}\nGUARD_BODY\npython3 {target}"
                    self.assertEqual(guard.classify(wrapper, info["cwd"]), expected)
                local = self.write("tmp/reporter.py", body)
                self.assertIsNone(self.classify("python3 tmp/reporter.py"))
                local.write_text(body + f"\nopen({LIVE!r}).read()")
                self.assertEqual(self.classify("python3 tmp/reporter.py"), SCRIPT)

    def test_remote_setup_strings_in_python_540(self):
        fixtures = Path(__file__).with_name("fixtures")
        command = (fixtures / "robob-540-s78-inline-edit-repo-setup.sh").read_text()
        cwd = "/Users/ardud/checkouts/offbox-repo-setup"
        self.assertIsNone(guard.classify(command, cwd))
        twin = command.replace("\nPY", f"\nopen({LIVE!r}).read()\nPY", 1)
        self.assertNotEqual(twin, command)
        self.assertEqual(guard.classify(twin, cwd), READ)

    def test_reporter_edits_and_markdown_keep_db_reads_checked(self):
        fixtures = Path(__file__).with_name("fixtures")
        manifest = json.loads((fixtures / "manifest.json").read_text())
        names = (
            "crpko-3122-terraform-python-edit.sh", "crpko-358-markdown-pytest.sh",
            "crpko-3041-r1-python-edit.sh", "crpko-2808-heredoc-relative-node-test.sh",
            "crpko-2996-python-edit-gofmt-offbox.sh",
            "crpko-3070-python-setup-offbox.sh",
            "crpko-1606-terraform-create-offbox-node.sh", "crpko-1606-append-relative-node-test.sh",
            "crpko-1606-results-markdown-write.sh",
        )
        for name in names:
            command = (fixtures / name).read_text()
            cwd = manifest[name]["cwd"]
            self.assertIsNone(guard.classify(command, cwd))
            written_read = f"\ncat > tmp/read-live.py <<'GUARD_TWIN'\nopen({LIVE!r}).read()\nGUARD_TWIN\npython3 tmp/read-live.py"
            self.assertEqual(guard.classify(command + written_read, cwd), SCRIPT)
            if manifest[name]["card"] in {3122, 3041, 2996}:
                twin = command.replace("\nPY", f"\nopen({LIVE!r}).read()\nPY", 1)
                self.assertNotEqual(twin, command)
                self.assertEqual(guard.classify(twin, cwd), READ)

    def test_new_inline_and_absolute_reporters(self):
        fixtures = Path(__file__).with_name("fixtures")
        manifest = json.loads((fixtures / "manifest.json").read_text())
        for name in ("crpko-2147-inline-test-edit.sh", "robob-712-heredoc-absolute-no-workdir.sh"):
            command = (fixtures / name).read_text()
            info = manifest[name]
            self.assertIsNone(guard.classify(command, info["cwd"]))
            if info["card"] == 2147:
                twin = command.replace("\nPY", f"\nopen({LIVE!r}).read()\nPY", 1)
                expected = READ
            else:
                header, rest = command.split("\n", 1)
                _, invoke = rest.rsplit("\nPY\n", 1)
                twin = header + f"\nopen({LIVE!r}).read()\nPY\n" + invoke
                expected = SCRIPT
                self.assertIsNone(info["workdir"])
                for cwd in (info["cwd"], None):
                    self.assertIsNone(guard.classify(command, cwd))
                    self.assertEqual(guard.classify(twin, cwd), SCRIPT)
            self.assertNotEqual(twin, command)
            self.assertEqual(guard.classify(twin, info["cwd"]), expected)
            for harness, tool, field in (("codex", "exec_command", "cmd"), ("codex", "Bash", "command"), ("claude", "Bash", "command")):
                for cmd, rule in ((command, None), (twin, expected)):
                    event = {"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": {field: cmd}, "cwd": info["cwd"]}
                    with self.subTest(fixture=name, harness=harness, tool=tool, rule=rule), patch.object(engine, "_log"):
                        result = engine.decide(event, harness)
                        self.assertEqual(result["decision"], "deny" if rule else "allow")
                        if rule:
                            self.assertEqual(result["context"]["rule"], rule)

    def test_merge_round_reporter_heredocs(self):
        fixtures = Path(__file__).with_name("fixtures")
        manifest = json.loads((fixtures / "manifest.json").read_text())
        for name in ("crpko-2697-python-prose-facts.sh", "torssh-29-native-build-heredocs.sh"):
            command = (fixtures / name).read_text()
            cwd = manifest[name]["cwd"]
            with self.subTest(fixture=name):
                self.assertIsNone(guard.classify(command, cwd))
                body, ending = command.rsplit("\nPY", 1)
                twin = body + f"\nopen({LIVE!r}).read()\nPY" + ending
                self.assertEqual(guard.classify(twin, cwd), READ)

    def test_2147_text_search_filters(self):
        search = "rg -l -i 'qa-access|audit_qualify|harness-qa-audit-reader|reader.grants'"
        roots = "/Users/ardud/.robob/harness-homes/codex/skills /Users/ardud/.config/robob-watch /Users/ardud/.local/share/robob-watch"
        self.table([
            (search + " -g '*.md' -g '*.json' -g '*.yaml' -g '*.yml' " + roots, None),
            (search + " -g '!node_modules' -g '!logs' -g '!*.sqlite*' -g '!opencode.db' -g '!statev2.sqlite' " + roots, None),
            (search + " -g '*statev2.sqlite*' " + roots, READ),
            (search + " -g '*opencode.db*' " + roots, READ),
            (search + " " + LIVE, READ),
        ])

    def test_pure_cat_source_and_markdown_2697(self):
        fixtures = Path(__file__).with_name("fixtures")
        for name in ("crpko-2697-source-and-test-heredocs.sh", "crpko-2697-facts-heredoc.sh"):
            command = (fixtures / name).read_text()
            self.assertEqual(guard.scripts_in(command, str(self.root)), [])
            self.assertIsNone(self.classify(command))

    def test_ovnfs_and_worktree_cwd_resolve_equally(self):
        for cwd in ("/Users/ardud/checkouts/guard-fixture", "/Users/ardud/.robob/worktrees/project/guard-fixture"):
            for body, expected in [("print('safe')", None), (f"open({LIVE!r}).read()", SCRIPT)]:
                command = f"cat > scripts/proof.py <<'EOF'\n{body}\nEOF\npython3 scripts/proof.py"
                with self.subTest(cwd=cwd, expected=expected):
                    self.assertEqual(guard.classify(command, cwd), expected)

    def test_existing_script_after_python_edit_is_still_checked(self):
        command = "python3 - <<'PY'\nfrom pathlib import Path\np=Path('main.tf'); p.write_text(p.read_text().replace(\"it's\", 'its'))\nPY\nnode --test scripts/t.mjs"
        self.write("scripts/t.mjs", "console.log('ok')")
        self.assertIsNone(self.classify(command))
        self.write("scripts/t.mjs", f"require('fs').readFileSync({LIVE!r})")
        self.assertEqual(self.classify(command), SCRIPT)
        self.write("scripts/t.mjs", "console.log('ok')")
        command = command.replace("\nnode --test", "\n&& node --test")
        self.assertIsNone(self.classify(command))
        command = "python3 - <<'PY' && node --test scripts/t.mjs\nfrom pathlib import Path\np=Path('main.tf'); p.write_text(p.read_text().replace(\"it's\", 'its'))\nPY"
        self.assertIsNone(self.classify(command))

    def test_real_written_and_existing_script_bodies(self):
        fixtures = Path(__file__).with_name("fixtures")
        for name, target, interpreter in [
            ("usdtwallet-142-campaign.py", "tmp/142/campaign.py", "python3"),
            ("usdtwallet-142-loops.sh", "tmp/142/loops.sh", "bash"),
            ("usdtwallet-140-proof.sh", "tmp/card140/proof.sh", "offbox run -- bash"),
            ("crpko-2774-make_cancel_probes.py", str(self.root / "probes/make.py"), "python3"),
        ]:
            body = (fixtures / "bodies" / name).read_text()
            command = f"cat > {target} <<'EOF'\n{body}\nEOF\n{interpreter} {target}"
            with self.subTest(body=name):
                self.assertIsNone(self.classify(command))
        self.write("tmp/escrow-settlement/edit.py", (fixtures / "bodies/crpko-2743-edit.py").read_text())
        self.assertIsNone(self.classify((fixtures / "crpko-2743-edit.sh").read_text()))
        self.assertIsNone(self.classify("cat > testhost/.secrets/check.py <<'EOF'\nprint('safe fixture')\nEOF\npython3 testhost/.secrets/check.py ssh test"))

    def test_node_heredoc_with_shell_prose_2982(self):
        body = "const fs = require('fs');\nconst data = fs.readFileSync('tmp/card-2982/s4-final.json', 'utf8');\nconst report = `Result: ${data}\n- node --test scripts/check.mjs\n- python3 $X\n- bash \\\"$Y\\\"`;\nfs.writeFileSync('tmp/card-2982/s4-evidence.md', report);\n"
        self.assertIsNone(self.classify("node - <<'NODE'\n" + body + "NODE"))
        self.assertEqual(self.classify("node - <<'NODE'\n" + body.replace("tmp/card-2982/s4-final.json", LIVE) + "NODE"), READ)

    def test_compound_python_node_stdin_1245(self):
        fixtures = Path(__file__).with_name("fixtures")
        command = (fixtures / "crpko-1245-python-node-stdin.sh").read_text()
        cwd = "/Volumes/ExternalSSD/board-wt/crpko-devops-native-init-floors"
        self.assertIsNone(guard.classify(command, cwd))
        self.assertIn("node --input-type=module - <<'JS'", command)
        self.assertIn("npm run validate:plan", command)
        for flags in ("", "--input-type=module ", "--no-warnings --input-type=module "):
            variant = command.replace("node --input-type=module -", f"node {flags}-")
            with self.subTest(flags=flags, reader=None):
                self.assertIsNone(guard.classify(variant, cwd))
            for delimiter, read in [
                ("PY", 'from pathlib import Path; Path("~/.robob/userdata/statev2.sqlite").expanduser().read_bytes()'),
                ("JS", "const liveDbFs = await import('node:fs'); liveDbFs.readFileSync(process.env.HOME + '/.robob/userdata/statev2.sqlite');"),
            ]:
                twin = variant.replace(f"\n{delimiter}\n", f"\n{read}\n{delimiter}\n", 1)
                self.assertNotEqual(twin, variant)
                with self.subTest(flags=flags, reader=delimiter):
                    self.assertEqual(guard.classify(twin, cwd), READ)

    def test_python_setup_then_offbox_timeout_2154(self):
        fixtures = Path(__file__).with_name("fixtures")
        command = (fixtures / "crpko-2154-python-offbox-timeout.sh").read_text()
        cwd = "/Volumes/ExternalSSD/board-wt/crpko-integration-harness-HC-021d"
        self.assertIsNone(guard.classify(command, cwd))
        script = Path(os.path.realpath(Path(cwd) / "tmp/hc021d/check.sh"))
        self.assertIn(script, guard.scripts_in(command, cwd))
        setup, separator, remote = command.partition("\n offbox run ")
        self.assertIn("python3 - <<'PY'", setup)
        self.assertTrue(separator)
        wrapped = "offbox run " + remote
        self.write("tmp/hc021d/check.sh", "echo safe\n")
        self.assertIsNone(self.classify(wrapped))
        self.write("tmp/hc021d/check.sh", "sqlite3 ~/.robob/userdata/statev2.sqlite .tables\n")
        self.assertEqual(self.classify(wrapped), SCRIPT)

    def test_diagnostics_and_limits(self):
        for command, detail in [
            ("python3 $X", "$X"),
            ('cd "$D" && python3 x.py', "cd to a non-literal"),
            ("python3 'x.py", "unbalanced quote"),
            ("for d in a b; do cd $d; python3 t.py; done", "loop that changes directory"),
            (";".join(f"python3 s{i}.py" for i in range(guard.MAX_SCRIPTS + 1)), "MAX_SCRIPTS"),
        ]:
            with self.subTest(command=command):
                rule, cause = guard.classify_detail(command, str(self.root))
                self.assertEqual(rule, UNRESOLVED)
                self.assertIn(detail, cause)
        nested = "python3 tmp/t.py"
        for _ in range(3):
            nested = "bash -c " + shlex.quote(nested)
        with patch.object(guard, "MAX_SHELL_DEPTH", 2):
            self.assertIn("MAX_SHELL_DEPTH", guard.classify_detail(nested, str(self.root))[1])

    def test_engine_guard_failure_is_closed_and_cause_is_logged(self):
        event = {"hook_event_name": "PreToolUse", "tool_name": "exec_command", "tool_input": {"cmd": "python3 $X", "workdir": str(self.root)}}
        with patch.object(engine, "_state", return_value=self.root / "hook-state"):
            result = engine.decide(event, "codex")
            line = json.loads((self.root / "hook-state/decisions.jsonl").read_text().splitlines()[-1])
            self.assertEqual(line["cause"], result["context"]["cause"])
        with patch.object(guard, "classify_detail", side_effect=ValueError("broken")), patch.object(engine, "_log"), patch.object(engine, "resolve_identity", side_effect=AssertionError("must deny before identity")):
            result = engine.decide(event, "codex")
            self.assertEqual(result["decision"], "deny")
            self.assertEqual(result["context"]["rule"], "live-database-unavailable")

    def test_codex_code_mode_reporter_events(self):
        fixtures = Path(__file__).with_name("fixtures")
        manifest = json.loads((fixtures / "manifest.json").read_text())
        for name in ("crpko-3060-code-mode.js", "usdtwallet-165-code-mode.js"):
            source = (fixtures / name).read_text()
            calls = code_mode_fixture.commands(source, "/unrelated/event/cwd")
            self.assertEqual(len(calls), 1)
            command, cwd = calls[0]
            self.assertEqual(cwd, manifest[name]["cwd"])
            self.assertIsNone(guard.classify(command, cwd))
            twin = command.replace("\nPY", f"\nopen({LIVE!r}).read()\nPY", 1)
            self.assertNotEqual(twin, command)
            for cmd, expected in ((command, None), (twin, READ if manifest[name]["card"] == 3060 else SCRIPT)):
                # Codex 0.166 normalizes each nested exec_command this way.
                event = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": cwd}
                with self.subTest(fixture=name, expected=expected), patch.object(engine, "_log"):
                    result = engine.decide(event, "codex")
                    self.assertEqual(result["decision"], "deny" if expected else "allow")
                    if expected:
                        self.assertEqual(result["context"]["rule"], expected)
            for checkout in ("/Users/ardud/checkouts/devops-timeline-identity", "/Users/ardud/checkouts/race-gate-hold-pairs"):
                self.assertIsNone(guard.classify("python3 - <<'PY'\nfrom pathlib import Path\nPath('plan.json').write_text('{}')\nPY", checkout))

    def test_code_mode_fixture_extraction(self):
        safe, unsafe = self.write("safe/task.py", "print('safe')"), self.write("unsafe/task.py", f"open({LIVE!r}).read()")
        cell = (f"text(await tools.exec_command({{cmd:'python3 task.py', 'workdir':{json.dumps(str(safe.parent))}}}));\n"
                "const status = await tools.mcp__t3_code__task_status({taskId:'other'});\n"
                f"await tools.exec_command({{\"cmd\":'python3 task.py',workdir:{json.dumps(str(unsafe.parent))}}});\n"
                "text(await tools.write_stdin({session_id:123,chars:''}));")
        calls = code_mode_fixture.commands(cell, str(self.root))
        self.assertEqual([guard.classify(cmd, cwd) for cmd, cwd in calls], [None, SCRIPT])
        self.assertEqual(code_mode_fixture.commands("// tools.exec_command({cmd:secret})\nconst s='tools.exec_command({cmd:secret})';", str(self.root)), [])
        self.assertEqual(code_mode_fixture.commands("tools.exec_command({cmd:`python3 tmp/t.py`,cwd:'/tmp'});", str(self.root)), [("python3 tmp/t.py", "/tmp")])
        for source in (
            "tools.exec_command({cmd:command,workdir:'/tmp'})", "tools.exec_command({cmd:'python3 t.py',workdir:directory})",
            "tools.exec_command(args)", "tools.exec_command({cmd:`python3 ${script}`,workdir:'/tmp'})",
            "tools.exec_command({cmd:'safe',...args})", "tools.exec_command({cmd:'safe',['cmd']:command})",
            "tools.exec_command({cmd:'safe',cmd:command})", "tools.exec_command({cmd:'safe'} || args)",
        ):
            with self.subTest(source=source), self.assertRaises(code_mode_fixture.Unresolved):
                code_mode_fixture.commands(source, str(self.root))

    def test_engine_entrypoints_and_cwd(self):
        for harness, tool, field in [("codex", "exec_command", "cmd"), ("codex", "shell_command", "command"), ("claude", "Bash", "command"), ("codex", "mcp__x__bash", "cmd"), ("codex", "shell", "command"), ("claude", "mcp__x__shell", "command")]:
            for explicit in (False, True):
                for command, expected in [("sqlite3 " + LIVE, READ), ("python3 tmp/live.py", SCRIPT), ("python3 tmp/t.py", None), ("cat > tmp/x.py <<'PY'\n# it's safe\nPY", None), ("python3 $X", UNRESOLVED)]:
                    event = {"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": {field: command}, "cwd": str(self.root)}
                    if explicit:
                        event["tool_input"]["workdir"] = str(self.root)
                    with self.subTest(harness=harness, tool=tool, command=command, explicit=explicit), patch.object(engine, "_log"):
                        result = engine.decide(event, harness)
                        self.assertEqual(result["decision"], "deny" if expected else "allow")
                        if expected:
                            self.assertEqual(result["context"]["rule"], expected)
                        if expected == UNRESOLVED:
                            self.assertIn("$X", result["reason"])
                            self.assertIn(str(self.root), result["reason"])
                            self.assertNotIn("explicit workdir", result["reason"])
                            self.assertIn("cause", result["context"])


SRC = Path(__file__).resolve().parents[1] / "src"


class LiveDatabaseGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="live-db-guard-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {"HOME": str(self.root), "HARNESS_HOOKS_STATE_DIR": str(self.root / "state")})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_direct_live_read_vectors(self):
        commands = [
            "sqlite3 ~/.robob/userdata/statev2.sqlite 'select 1'",
            "sqlite3 'file:/Volumes/ExternalSSD/robob-data/userdata/statev2.sqlite?mode=ro' 'select 1'",
            "sqlite3 ~/.robob/userdata/statev2.sqlite 'VACUUM INTO /tmp/copy.sqlite'",
            "python3 -c \"import sqlite3; sqlite3.connect('/Users/ardud/.robob/userdata/statev2.sqlite')\"",
            "node -e \"new Database(process.env.HOME+'/.robob/userdata/statev2.sqlite')\"",
            "bun run -e \"new Database('/Volumes/ExternalSSD/robob-data/userdata/statev2.sqlite')\"",
            "cp ~/.robob/userdata/statev2.sqlite /tmp/copy.sqlite",
            "rsync ~/.robob/userdata/*.sqlite /tmp/",
            "cat $HOME/.robob/userdata/statev2.sqlite-wal",
            "sqlite3 ~/.local/share/opencode/opencode.db 'select 1'",
            "bash -c 'sqlite3 ~/.robob/userdata/statev2.sqlite \"select 1\"'",
            'sh -c "python3 -c \'sqlite3.connect(\"/Users/ardud/.local/share/opencode/opencode.db\")\'"',
            "python3.14 -c \"sqlite3.connect(str(Path.home()/'.local/share'/'opencode'/'opencode.db'))\"",
            "node -e \"new Database('/Volumes/ExternalSSD/opencode-data/opencode.db')\"",
            "python3 - <<'PY'\nimport sqlite3\nsqlite3.connect(str(Path.home()/'.robob'/'userdata'/'statev2.sqlite'))\nPY",
        ]
        for command in commands:
            with self.subTest(command=command):
                self.assertEqual(guard.classify(command, str(self.root)), "live-database-read")

    def test_metadata_copies_and_source_paths_are_allowed(self):
        source = self.root / "statev2-guard.ts"
        source.write_text("const live = '/Users/ardud/.robob/userdata/statev2.sqlite';")
        for command in [
            "ls -lh ~/.robob/userdata/statev2.sqlite", "stat ~/.local/share/opencode/opencode.db",
            "du -h ~/.robob/userdata/statev2.sqlite", "lsof ~/.robob/userdata/statev2.sqlite",
            "sqlite3 /tmp/isolated/statev2.sqlite 'select 1'",
            "sqlite3 /tmp/isolated/opencode.db 'select 1'",
            f"cat {source}",
            "node integrations/harness-hooks/src/engine.py",
        ]:
            with self.subTest(command=command):
                self.assertIsNone(guard.classify(command, str(self.root)))

    def test_relative_names_in_live_directory(self):
        self.assertEqual(guard.classify("sqlite3 statev2.sqlite 'select 1'", "/Users/ardud/.robob/userdata"), "live-database-read")
        self.assertEqual(guard.classify("sqlite3 opencode.db 'select 1'", "/Users/ardud/.local/share/opencode"), "live-database-read")

    def test_home_expansion_aliases_and_backup_commands(self):
        live = self.root / ".robob/userdata/statev2.sqlite"
        alias = self.root / "alias.sqlite"
        alias.symlink_to(live)
        for command in [f"sqlite3 {alias} 'select 1'", "sqlite3 ./alias.sqlite 'select 1'",
                        "cp alias.sqlite backup.sqlite", f"dd if=/Users/ardud/.robob/userdata/statev2.sqlite of={self.root}/copy.sqlite",
                        "sqlite3 ${HOME}/.robob/userdata/statev2.sqlite 'select 1'",
                        "sqlite3 $HOME/.local/share/opencode/opencode.db 'select 1'",
                        "sqlite3 /tmp/copy.sqlite '.backup /Users/ardud/.robob/userdata/statev2.sqlite'",
                        "cp /tmp/copy.sqlite ~/.robob/userdata/statev2.sqlite"]:
            with self.subTest(command=command):
                self.assertEqual(guard.classify(command, str(self.root)), "live-database-read")
        self.assertFalse(live.exists())

    def test_script_vectors_and_bounded_source_inspection(self):
        for name, source in [
            ("measure.py", "sqlite3.connect(str(Path.home()/'.robob'/'userdata'/'statev2.sqlite'))"),
            ("analyze.mjs", "new Database('/Users/ardud/.local/share/opencode/opencode.db')"),
            ("spaced probe.py", "db = '/Volumes/ExternalSSD/robob-data/userdata/statev2.sqlite'"),
        ]:
            (self.root / name).write_text(source)
        for command in ["python3 measure.py", "uv run python3 measure.py", "node analyze.mjs", "./measure.py", "bash -c 'python3 measure.py'"]:
            with self.subTest(command=command):
                self.assertEqual(guard.classify(command, str(self.root)), "live-database-script")
        self.assertIsNone(guard.classify('python3 "spaced probe.py"', str(self.root)))
        (self.root / "copy.py").write_text("sqlite3.connect('/tmp/isolated/statev2.sqlite')")
        (self.root / "large.py").write_text(" " * (guard.MAX_SOURCE_BYTES + 1))
        self.assertIsNone(guard.classify("python3 copy.py", str(self.root)))
        self.assertIsNone(guard.classify("cat measure.py", str(self.root)))
        self.assertIsNone(guard.classify("python3 missing.py", str(self.root)))
        self.assertIsNone(guard.classify("python3 large.py", str(self.root)))
        (self.root / "linked.py").symlink_to("/Users/ardud/.robob/userdata/statev2.sqlite")
        with patch.object(Path, "open", side_effect=AssertionError("must not read database symlink")):
            self.assertEqual(guard.classify("python3 linked.py", str(self.root)), "live-database-read")

    def test_policy_runs_before_identity_offbox_or_coord_and_does_not_log_sql(self):
        command = "sqlite3 ~/.robob/userdata/statev2.sqlite 'select private_sql'"
        for harness in ("claude", "codex"):
            for tool in ("Bash", "bash", "shell", "exec_command", "shell_command", "mcp__test__exec_command", "mcp__test__shell"):
                with self.subTest(harness=harness, tool=tool), patch.object(engine, "resolve_identity", side_effect=AssertionError("identity called")), patch.object(engine, "_classify_offbox", side_effect=AssertionError("classifier called")):
                    event = {"hook_event_name": "PreToolUse", "session_id": "fixture", "cwd": str(self.root),
                             "tool_name": tool, "tool_input": {"cmd" if "exec_command" in tool else "command": command}}
                    result = engine.decide(event, harness)
                    self.assertEqual(result["decision"], "deny")
                    self.assertEqual(result["context"]["rule"], "live-database-read")
                    run = subprocess.run([sys.executable, str(SRC / f"{harness}.py")], input=json.dumps(event),
                                         capture_output=True, text=True, check=True, timeout=5)
                    output = json.loads(run.stdout)["hookSpecificOutput"]
                    self.assertEqual(output["permissionDecision"], "deny")
                    self.assertNotIn("private_sql", output["permissionDecisionReason"])
        audit = (self.root / "state/decisions.jsonl").read_text()
        self.assertNotIn("private_sql", audit)
        self.assertEqual({json.loads(line)["rule"] for line in audit.splitlines()}, {"live-database-read"})

    def test_script_cwd_changes_wrappers_and_subshells(self):
        sub = self.root / "sub"
        sub.mkdir()
        (sub / "probe.py").write_text("sqlite3.connect('/Users/ardud/.robob/userdata/statev2.sqlite')")
        (sub / "safe.py").write_text("print('safe')")
        (self.root / "probe.py").write_text("print('root safe')")
        for command in [
            "cd sub && python3 probe.py", "cd sub; node probe.py", "cd sub\npython3 probe.py",
            "(cd sub && python3 probe.py)", "(cd sub && python3 probe.py); npm test",
            "bash -lc 'cd sub && python3 probe.py'", "env X=1 bash -c 'cd sub; python3 probe.py'",
            "command python3 sub/probe.py", "cd sub && env X=1 python3 probe.py",
            "cd sub && uv run python3 probe.py", "uv run --directory sub python3 probe.py",
            "env --chdir sub python3 probe.py", "{ cd sub; python3 probe.py; }",
            "bash -c '(cd sub && python3 probe.py)'", "cd sub && ./probe.py",
        ]:
            with self.subTest(command=command):
                self.assertEqual(guard.classify(command, str(self.root)), "live-database-script")
        for command in [
            "cd sub && python3 safe.py", "(cd sub && python3 safe.py); python3 probe.py",
            "bash -lc 'cd sub && python3 safe.py'", "cd sub && uv run python3 safe.py",
            "env --chdir sub python3 safe.py; python3 probe.py",
            "env --chdir sub bash -c 'python3 safe.py'; python3 probe.py",
            "cd sub && cd .. && python3 probe.py", "{ cd sub; python3 safe.py; }",
        ]:
            with self.subTest(command=command):
                self.assertIsNone(guard.classify(command, str(self.root)))

    def test_unresolved_cwd_denies_explicit_scripts_not_unrelated_binaries(self):
        for command in [
            'cd "$TARGET" && python3 probe.py', 'cd "$(pwd)" && node probe.mjs',
            "cd sub || python3 probe.py", "pushd sub; python3 probe.py",
            'bash -lc \'cd "$TARGET"; python3 probe.py\'',
            "if true; then cd sub; fi; python3 probe.py",
        ]:
            with self.subTest(command=command):
                self.assertEqual(guard.classify(command, str(self.root)), "live-database-script-unresolved")
        for command in ['cd "$TARGET" && npm test', "npm run missing-script", "missing-tool", 'cd "$TARGET" && python3 --version']:
            with self.subTest(command=command):
                self.assertIsNone(guard.classify(command, str(self.root)))
        event = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "session_id": "fixture",
                 "cwd": str(self.root), "tool_input": {"command": 'cd "$TARGET" && python3 probe.py'}}
        with patch.object(engine, "resolve_identity", side_effect=AssertionError("identity called")):
            result = engine.decide(event, "claude")
        self.assertEqual(result["decision"], "deny")
        self.assertIn("non-literal", result["reason"])
        self.assertIn(str(self.root), result["reason"])
        self.assertEqual(result["context"]["rule"], "live-database-script-unresolved")

    def test_unexpected_local_guard_error_never_allows_a_shell(self):
        event = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "session_id": "fixture",
                 "cwd": str(self.root), "tool_input": {"command": "python3 probe.py"}}
        with patch.object(guard, "classify_detail", side_effect=RuntimeError("private error")), patch.object(engine, "resolve_identity", side_effect=AssertionError("identity called")):
            result = engine.decide(event, "claude")
        self.assertEqual(result["decision"], "deny")
        self.assertEqual(result["context"]["rule"], "live-database-unavailable")
        self.assertNotIn("private error", result["reason"])
        self.assertNotIn("private error", (self.root / "state/decisions.jsonl").read_text())


if __name__ == "__main__":
    unittest.main()

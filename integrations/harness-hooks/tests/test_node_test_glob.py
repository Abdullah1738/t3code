"""node --test glob targets use the same content checks as literal targets."""
if __package__:
    from . import test_environment
else:
    import test_environment

from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import isolated_source_cases
import statev2_guard as guard


SAFE = "import test from 'node:test'; test('temporary data', () => {});\n"
BAD = "import test from 'node:test'; import {readFileSync} from 'node:fs'; readFileSync('~/.t3/userdata/statev2.sqlite');\n"
REPORTER1 = "offbox run -- sh -c 'npm install --no-audit --no-fund && node --import ./test/setup-log-dir.js --test --test-concurrency=1 test/*.test.js'"
CHAIN = 'node --version && node --test integrations/stream-recovery/test/*.test.mjs && node --test integrations/router-logging/test/*.test.mjs'
NPM_CHAIN = 'npm --prefix integrations/stream-recovery test && node --test integrations/router-logging/test/*.test.mjs'


def write(root, name, source=SAFE):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source)
    return path


def worktree(root, name, sources):
    repo, checkout = root / (name + '-repo'), root / name
    repo.mkdir()
    for path, source in sources.items():
        write(repo, path, source)
    def git(*args):
        subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test',
                        '-c', 'user.email=test@example.invalid', *args], cwd=repo,
                       check=True, capture_output=True)
    git('init', '-q')
    git('add', '.')
    git('commit', '-qm', 'test fixtures')
    git('worktree', 'add', '--detach', str(checkout))
    return checkout


def fixtures(root):
    a = root / 'a'
    for path in ('test/setup-log-dir.js', 'test/a.test.js', 'test/b.test.js', 'test/sub/c.test.js'):
        write(a, path, 'console.log("setup");' if 'setup-' in path else SAFE)
    b = worktree(root, 'b', {
        'integrations/stream-recovery/package.json': '{"scripts":{"test":"node --test test/*.test.mjs"}}',
        'integrations/stream-recovery/test/x.test.mjs': SAFE,
        'integrations/stream-recovery/test/y.test.mjs': SAFE,
        'integrations/router-logging/test/components.test.mjs': SAFE,
        'integrations/router-logging/test/toollog.test.mjs': SAFE,
        'integrations/router-logging/test/support.mjs': 'export const value = 1;',
        'integrations/router-logging/test/fixtures/data.json': '{}',
    })
    c = worktree(root, 'c', {**{f'test/t{i:02d}.test.mjs': "import './helpers.mjs'; " + SAFE for i in range(1, 36)},
                              'test/helpers.mjs': 'export const value = 1;'})
    return a, b, c


def reporter_cases(a, b, c):
    return [
        ('dia23', REPORTER1, a),
        ('9router31', 'offbox run -- ' + shlex.quote(CHAIN), b),
        ('9router31-local', CHAIN, b),
        ('9router33', 'offbox run -- ' + shlex.quote(NPM_CHAIN), b),
        ('9router38-bg', 'offbox run --bg -- ' + shlex.quote(NPM_CHAIN), b),
        ('crw35-glob', 'node --test test/*.test.mjs', c),
        ('crw35-literals', 'node --test ' + shlex.join(str(c / f'test/t{i:02d}.test.mjs') for i in range(1, 36)), c),
        ('crw35-offbox', "offbox run -- 'node --test test/*.test.mjs'", c),
    ]


class NodeTestGlobTests(unittest.TestCase):
    def setUp(self):
        clean = isolated_source_cases.fixture_environment_patch()
        clean.start()
        self.addCleanup(clean.stop)
        temp = tempfile.TemporaryDirectory(prefix='node-test-glob-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.a, self.b, self.c = fixtures(self.root)

    def assert_decision(self, command, cwd, expected=None, cause=None):
        rule, detail = guard.classify_detail(command, str(cwd))
        self.assertEqual(rule, expected, (command, detail))
        if cause:
            self.assertIn(cause, detail)

    def test_reporters_and_literal_predecessors(self):
        for label, command, cwd in reporter_cases(self.a, self.b, self.c):
            with self.subTest(case=label):
                self.assertTrue((cwd / '.git').is_file() if cwd != self.a else cwd.is_dir())
                self.assert_decision(command, cwd)
        literal = 'node --version && node --test integrations/stream-recovery/test/x.test.mjs && node --test integrations/router-logging/test/toollog.test.mjs'
        self.assert_decision(literal, self.b)
        self.assert_decision(NPM_CHAIN.replace('*.test.mjs', 'toollog.test.mjs'), self.b)

    def test_glob_shapes_and_hidden_segments(self):
        write(self.a, 'test/.hidden.test.js', BAD)
        write(self.a, 'test/.hidden/nested.test.js', BAD)
        for pattern in ('test/*.test.js', 'test/?.test.js', 'test/[ab].test.js',
                        'test/**/*.test.js', '"test/**/*.test.js"', "'test/**/*.test.js'"):
            with self.subTest(pattern=pattern):
                self.assert_decision('node --test ' + pattern, self.a)
        for pattern in ('test/.*.test.js', 'test/.hidden/*.test.js'):
            self.assert_decision('node --test ' + pattern, self.a, 'live-database-script')
        write(self.a, 'test/unusual?.test.js')
        self.assert_decision('node --test test/*.test.js', self.a)

    def test_character_class_semantics(self):
        write(self.a, 'test/b.test.js', BAD)
        for pattern, expected in (
            ('test/[a].test.js', None),
            ('test/[ab].test.js', 'live-database-script'),
            ('test/[a-b].test.js', 'live-database-script'),
            ('test/[!a].test.js', 'live-database-script'),
            ('test/[^a].test.js', 'live-database-script-unresolved'),
            ('test/[[:alpha:]].test.js', 'live-database-script-unresolved'),
            ('test/[[.a.]].test.js', 'live-database-script-unresolved'),
            ('test/[[=a=]].test.js', 'live-database-script-unresolved'),
        ):
            for quote in ('', '"', "'"):
                with self.subTest(pattern=pattern, quote=quote):
                    self.assert_decision('node --test ' + quote + pattern + quote, self.a, expected)

    def test_non_regular_matches_fail_closed(self):
        write(self.a, 'test/unit/index.js', BAD)
        (self.a / 'test/link').symlink_to(self.a / 'test/unit', target_is_directory=True)
        (self.a / 'test/broken').symlink_to(self.root / 'missing')
        for pattern in ('test/*', 'test/l*', 'test/broken*', 'test/u*'):
            with self.subTest(pattern=pattern):
                self.assert_decision('node --test ' + pattern, self.a, 'live-database-script-unresolved')

    def test_every_match_uses_literal_content_scan(self):
        bad = write(self.a, 'test/c.test.js', BAD)
        literal = guard.classify_detail('node --test ' + str(bad), str(self.a))
        self.assertEqual(literal[0], 'live-database-script')
        self.assertEqual(guard.classify_detail('node --test test/*.test.js', str(self.a)), literal)
        write(self.b, 'integrations/router-logging/test/z.test.mjs', BAD)
        for payload in (CHAIN, NPM_CHAIN):
            for prefix in ('', 'offbox run -- ', 'offbox run --bg -- '):
                command = prefix + shlex.quote(payload) if prefix else payload
                self.assert_decision(command, self.b, 'live-database-script')
        write(self.c, 'test/t35.test.mjs', BAD)
        for label, command, cwd in reporter_cases(self.a, self.b, self.c):
            if cwd == self.c:
                with self.subTest(case=label):
                    self.assert_decision(command, cwd, 'live-database-script', 't35.test.mjs')

    def test_symlink_targets_are_scanned(self):
        target = write(self.root, 'bad.mjs', BAD)
        (self.a / 'test/link.test.js').symlink_to(target)
        self.assert_decision('node --test test/*.test.js', self.a, 'live-database-script')
        (self.a / 'test/link.test.js').unlink()
        (self.a / 'linked').symlink_to(self.a / 'test', target_is_directory=True)
        self.assert_decision('node --test linked/*.test.js', self.a)
        self.assert_decision("printf x > test/new.js; node --test linked/*.test.js", self.a,
                             'live-database-script-unresolved', 'written in the same call')
        self.assert_decision(f"printf x > {target}; node --test test/*.test.js", self.a)
        (self.a / 'test/external.test.js').symlink_to(target)
        self.assert_decision(f"printf x > {target}; node --test test/*.test.js", self.a,
                             'live-database-script-unresolved', 'written in the same call')

    def test_unknown_or_unsupported_globs_fail_closed(self):
        for command, cause in (
            ('node --test missing/*.test.js', 'matched no files'),
            ('cd "$X" && node --test test/*.test.js', 'non-literal directory'),
            ('node --test $D/*.test.js', 'unsupported expansion'),
            ('D=test; node --test $D/*.test.js', 'unsupported expansion'),
            ('node --test test/{a,b}.test.js', 'brace expansion'),
            ('node --test "test/{a,b}*.test.js"', 'unsupported expansion'),
            ('node --test "test/\\*.test.js"', 'unsupported expansion'),
            ('node --test test/\\*.test.js', 'unsupported backslash expansion'),
        ):
            with self.subTest(command=command):
                self.assert_decision(command, self.a, 'live-database-script-unresolved', cause)

    def test_same_call_writes(self):
        body = "cat > test/z.test.js <<'EOF'\n" + SAFE + 'EOF\n'
        for predecessor in (body, 'printf x > test/z.test.js; ', 'cp other.mjs test/new.test.js; ',
                            'mv other.mjs test/new.test.js; ', 'mkdir test/new; ',
                            'git checkout HEAD -- test; ', 'printf x > "$UNKNOWN"; ',
                            'cp other.mjs "$UNKNOWN"; '):
            for prefix in ('', 'offbox run --bg -- '):
                payload = predecessor + 'node --test test/*.test.js'
                command = prefix + shlex.quote(payload) if prefix else payload
                with self.subTest(command=command):
                    self.assert_decision(command, self.a, 'live-database-script-unresolved', 'written in the same call')
        for predecessor in ('mkdir outside; ', 'printf x > outside.json; ', 'cp other.mjs outside.mjs; '):
            self.assert_decision(predecessor + 'node --test test/*.test.js', self.a)
        self.assert_decision("offbox run -- 'printf x > test/z.test.js'; node --test test/*.test.js", self.a,
                             'live-database-script-unresolved', 'written in the same call')

    def test_opaque_shell_predecessors_fail_closed(self):
        write(self.a, 'payload.mjs', BAD)
        write(self.a, 'prepare.sh', 'cp payload.mjs test/a.test.js\n')
        for shell in ('bash', 'sh', 'zsh', 'dash', 'ksh'):
            for invocation in ('prepare.sh', '-- prepare.sh', '< prepare.sh', '-s < prepare.sh', 'prepare.sh -c :', '-- prepare.sh -c :', '', '-s', '-'):
                for wrapper in ('', 'offbox run -- ', 'offbox run --bg -- '):
                    payload = f'{shell} {invocation} && node --test test/*.test.js'
                    command = wrapper + shlex.quote(payload) if wrapper else payload
                    with self.subTest(shell=shell, invocation=invocation, wrapper=wrapper):
                        self.assert_decision(command, self.a, 'live-database-script-unresolved', 'written in the same call')
        for payload in ('cat prepare.sh | bash; node --test test/*.test.js',
                        "offbox run -- bash prepare.sh; node --test test/*.test.js",
                        "offbox run -- bash < prepare.sh; node --test test/*.test.js"):
            self.assert_decision(payload, self.a, 'live-database-script-unresolved', 'written in the same call')

    def test_inspected_shell_predecessors_keep_write_tracking(self):
        for shell in ('bash', 'sh', 'zsh', 'dash', 'ksh'):
            for body, expected in ((':', None), ('node --version', None),
                                   ('cp payload.mjs test/a.test.js', 'live-database-script-unresolved')):
                for invocation in (shell + ' -c ' + shlex.quote(body) + '; ',
                                   shell + " <<'EOF'\n" + body + '\nEOF\n',
                                   shell + ' <<< ' + shlex.quote(body) + '; '):
                    for wrapper in ('', 'offbox run -- ', 'offbox run --bg -- '):
                        payload = invocation + 'node --test test/*.test.js'
                        command = wrapper + shlex.quote(payload) if wrapper else payload
                        with self.subTest(shell=shell, body=body, invocation=invocation, wrapper=wrapper):
                            self.assert_decision(command, self.a, expected,
                                                 'written in the same call' if expected else None)

    def test_shell_option_boundary_keeps_command_body_scan(self):
        for shell in ('bash', 'sh', 'zsh', 'dash', 'ksh'):
            for suffix in (' -n', ' -- -n', ' name -n', ' -- -c : -n'):
                for wrapper in ('', 'offbox run -- ', 'offbox run --bg -- '):
                    for body, expected in ((':', None), ('cp payload.mjs test/a.test.js', 'live-database-script-unresolved')):
                        payload = shell + ' -c ' + shlex.quote(body) + suffix + '; node --test test/*.test.js'
                        command = wrapper + shlex.quote(payload) if wrapper else payload
                        with self.subTest(shell=shell, suffix=suffix, wrapper=wrapper, body=body):
                            self.assert_decision(command, self.a, expected,
                                                 'written in the same call' if expected else None)

    def test_offbox_pull_invalidates_later_glob(self):
        for flags in ('--pull test', '--pull=test', '--no-sync --pull test', '--bg --pull=test'):
            for payload in ('node --version', 'node --test test/a.test.js', 'true'):
                command = 'offbox run ' + flags + ' -- ' + shlex.quote(payload) + '; node --test test/*.test.js'
                with self.subTest(flags=flags, payload=payload):
                    self.assert_decision(command, self.a, 'live-database-script-unresolved', 'written in the same call')

    def test_readwrite_redirects_keep_input_scan(self):
        for path in ('~/.robob/userdata/statev2.sqlite', '~/.t3/userdata/statev2.sqlite', '~/.local/share/opencode/opencode.db'):
            for prefix in ('cat ', '', ': ', 'cd . ', 'export D=test '):
                command = prefix + '<> ' + path
                with self.subTest(command=command):
                    self.assert_decision(command, self.a, 'live-database-read')
        write(self.a, 'input.sh', 'cat ~/.t3/userdata/statev2.sqlite')
        self.assert_decision('bash <> input.sh', self.a, 'live-database-script')
        self.assert_decision('bash < input.sh', self.a, 'live-database-script')

    def test_write_redirect_predecessor_forms(self):
        for operator in ('>', '>>', '>|', '&>', '&>>', '<>', '1>', '2>>', '1<>', '>&'):
            for writer in ('printf x ', '', ': ', 'export D=test ', 'cd . '):
                for target, expected in (('test/a.test.js', 'live-database-script-unresolved'),
                                         ('outside.txt', None), ('"$UNKNOWN"', 'live-database-script-unresolved')):
                    for wrapper in ('', 'offbox run -- ', 'offbox run --bg -- '):
                        payload = writer + operator + ' ' + target + '; node --test test/*.test.js'
                        command = wrapper + shlex.quote(payload) if wrapper else payload
                        with self.subTest(operator=operator, writer=writer, target=target, wrapper=wrapper):
                            self.assert_decision(command, self.a, expected,
                                                 'written in the same call' if expected else None)
        (self.a / '2').mkdir()
        self.assert_decision('printf x >&2/../test/a.test.js; node --test test/*.test.js', self.a,
                             'live-database-script-unresolved', 'written in the same call')
        for redirect in ('>>|', '>!', '>>!', '>&!'):
            self.assert_decision('printf x ' + redirect + 'test/a.test.js; node --test test/*.test.js', self.a,
                                 'live-database-script-unresolved', 'written in the same call')
        for redirect in ('2>&1', '2>& 1', '>&-', '0<&0'):
            self.assert_decision('printf x ' + redirect + '; node --test test/*.test.js', self.a)
        self.assert_decision("printf '%s' '&>' '<>' '>'; node --test test/*.test.js", self.a)

    def test_glob_uncheckable_file_fails_closed(self):
        write(self.a, 'test/large.test.js', ' ' * (guard.MAX_SOURCE_BYTES + 1))
        self.assert_decision('node --test test/*.test.js', self.a, 'live-database-script-unresolved', 'uncheckable file')

    def test_writes_through_wildcard_directory_symlinks(self):
        external = self.root / 'external'
        external.mkdir()
        (self.a / 'test/generated').symlink_to(external, target_is_directory=True)
        write(self.a, 'test/unit/a.test.js')
        write(self.a, 'source.mjs', BAD)
        for predecessor in ('cp source.mjs test/generated/new.test.js; ',
                            'mv source.mjs test/generated/new.test.js; ',
                            'printf x > test/generated/new.test.js; ',
                            'mkdir test/generated/new; '):
            for pattern in ('test/*/*.test.js', 'test/**/*.test.js'):
                with self.subTest(predecessor=predecessor, pattern=pattern):
                    self.assert_decision(predecessor + 'node --test ' + pattern, self.a,
                                         'live-database-script-unresolved', 'written in the same call')

    def test_remote_escaped_non_glob_paths_keep_their_scan(self):
        for name, source, expected in (('check-file.mjs', SAFE, None), ('bad-file.mjs', BAD, 'live-database-script')):
            write(self.a, 'scripts/' + name, source)
            escaped = 'scripts/' + name.replace('-', '\\-')
            for wrapper in ('offbox run -- ', 'offbox run --bg -- ', 'ssh box ', 'python3 /abs/offbox.py ssh box '):
                with self.subTest(name=name, wrapper=wrapper):
                    self.assert_decision(wrapper + 'node ' + escaped, self.a, expected)

    def test_split_budgets_and_remote_merge(self):
        for i in range(36, 201):
            write(self.c, f'test/t{i:02d}.test.mjs')
        for command in ('node --test test/*.test.mjs', "offbox run -- 'node --test test/*.test.mjs'",
                        'node --import test/helpers.mjs --test test/*.test.mjs'):
            self.assert_decision(command, self.c)
        write(self.c, 'test/t201.test.mjs')
        literals = 'node --test ' + shlex.join(str(self.c / f'test/t{i:02d}.test.mjs') for i in range(1, 202))
        first = 'node --test ' + shlex.join(str(self.c / f'test/t{i:02d}.test.mjs') for i in range(1, 101))
        second = 'node --test ' + shlex.join(str(self.c / f'test/t{i:02d}.test.mjs') for i in range(101, 202))
        for command in ('node --test test/*.test.mjs', literals,
                        "offbox run -- 'node --test test/*.test.mjs'", 'offbox run -- ' + shlex.quote(literals),
                        first + '; offbox run -- ' + shlex.quote(second)):
            self.assert_decision(command, self.c, 'live-database-script-unresolved', 'limit 200')
        reason = guard.refusal_reason('live-database-script-unresolved', 'node --test lists 201 test files', str(self.c))
        self.assertIn('Split the steps', reason)

    def test_other_scripts_keep_the_32_limit(self):
        files = [write(self.a, f's{i:02d}.sh', 'echo ok') for i in range(33)]
        command = '; '.join('bash ' + str(path) for path in files)
        for shape in (command, 'offbox run -- ' + shlex.quote(command),
                      'bash ' + str(files[0]) + '; offbox run -- ' + shlex.quote('; '.join('bash ' + str(path) for path in files[1:]))):
            self.assert_decision(shape, self.a, 'live-database-script-unresolved', 'MAX_SCRIPTS (32)')
        preloads = ' '.join('--import ' + str(write(self.a, f'pre{i}.mjs')) for i in range(33))
        self.assert_decision('node ' + preloads + ' --test test/*.test.js', self.a,
                             'live-database-script-unresolved', 'MAX_SCRIPTS (32)')
        self.assert_decision('node test/*.test.js', self.a, 'live-database-script-unresolved', 'non-literal script path')
        self.assert_decision('bun test test/*.test.js', self.a, 'live-database-script-unresolved', 'non-literal script path')


if __name__ == '__main__':
    unittest.main()

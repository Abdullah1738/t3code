"""Command-shape corpus for repair decisions and dependency advice."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import command_usage as usage


class CommandUsageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        (self.root / 'package.json').write_text('{"devDependencies":{"vitest":"1"}}')

    def inspect(self, cmd, **kw):
        return usage.inspect(self.root, '.', [cmd], **kw)

    def test_first_words_and_wrappers(self):
        cases = [
            ('pnpm install && vp test run x', False, True, 'pnpm install'),
            ('GOFLAGS=-mod=mod go test ./pkg', True, False, ''),
            ('cd sub && timeout 30s gofmt x.go', True, False, ''),
            ('node -e "$(go version)"', True, True, ''),
            ('env FOO=x timeout -s KILL 20 gomobile bind', True, False, ''),
            ('python3 -m pytest -q a.py', False, False, ''),
            ('uv run go test x.go', True, False, ''),
            ('uv run --with x --python 3 go test x.go', True, False, ''),
            ('uv run --no-group python go version', True, False, ''),
            ('uv run --only-group python go version', True, False, ''),
            ('uv run --unknown-option python go version', True, True, ''),
            ('uvx go test x.go', True, False, ''),
            ('uv --project sub run go test x.go', True, False, ''),
            ('npx go test x.go', True, True, ''),
            ('npm exec go test x.go', True, True, ''),
            ('uv run unknown-script', True, True, ''),
            ('node -v\ngo test x.go', True, True, ''),
            ('test "$(go env GOOS)" = linux', True, True, ''),
            ('VALUE=$(go version) python3 x.py', True, True, ''),
            ('VALUE=`go version` python3 x.py', True, True, ''),
            ('uv run --with pytest python -m pytest x', False, False, ''),
            ('bash scripts/x.sh', True, False, ''),
            ('./scripts/x.sh', True, False, ''),
            ('sh -c "pnpm install && cd sub && vp test run x"', False, True, 'pnpm install'),
            ('bash -lc "go test ./pkg"', True, False, ''),
            ('node_modules/.bin/vitest run', False, True, ''),
            ('./node_modules/.bin/custom-tool', False, True, ''),
            ('something-unknown test', True, True, ''),
            ('"unterminated', True, True, ''),
            ('cd "$PACKAGE" && vp test run', True, True, ''),
        ]
        for cmd, go, js, install in cases:
            with self.subTest(cmd=cmd):
                result = self.inspect(cmd)
                self.assertEqual((result.needs_go, result.uses_js, result.install), (go, js, install))
        for tool in usage.JS_TOOLS:
            with self.subTest(tool=tool):
                self.assertTrue(self.inspect(f'X=1 timeout 30 {tool} x').uses_js)

    def test_installer_corpus_uses_same_segments(self):
        installers = ('npm ci', 'npm install', 'npm i', 'pnpm install', 'pnpm i',
                      'yarn', 'yarn install', 'bun install', 'bun i', 'vp i', 'vp install')
        for install in installers:
            for form in (f'node -v && {install}', f'false || {install}', f'false; {install}',
                         f'false\n{install}\nnode x', f'false &&\n{install}',
                         f'false;\n{install}', f'false\n\n{install}', f'/usr/bin/env X=1 /usr/bin/timeout 30 corepack {install}',
                         f'cd sub && X=1 timeout 20 corepack {install}',
                         f'sh -c "{install} && node x"'):
                with self.subTest(form=form):
                    result = self.inspect(form)
                    self.assertTrue(result.uses_js)
                    self.assertEqual(result.install, install)
            self.assertEqual(self.inspect('', steps=['false', install, 'node x']).install, install)
        for cmd in ('npm test', 'pnpm test', 'yarn test', 'bun test', 'vp test', 'echo "npm ci"'):
            self.assertEqual(self.inspect(cmd).install, '', cmd)

    def test_go_manifests_at_root_cwd_and_cd_target(self):
        (self.root / 'sub').mkdir()
        for name in ('go.mod', 'go.work'):
            for folder in (self.root, self.root / 'sub'):
                with self.subTest(name=name, folder=folder):
                    (folder / name).touch()
                    result = usage.inspect(self.root, str(folder.relative_to(self.root)), ['pnpm test'])
                    self.assertTrue(result.needs_go)
                    self.assertTrue(self.inspect('cd sub && pnpm test').needs_go)
                    (folder / name).unlink()

    def test_nearest_package_and_step_cwds(self):
        sub = self.root / 'sub'
        (sub / 'deep').mkdir(parents=True)
        (sub / 'package.json').write_text('{"dependencies":{"x":"1"}}')
        for cmd in ('cd sub && bun test x', 'cd sub; bun test x', 'bash -c "cd sub && bun test x"',
                    'cd -P sub && bun test x', 'cd -L sub && bun test x',
                    'cd -e -P -- sub && bun test x', 'cd sub\nbun test x'):
            self.assertEqual(self.inspect(cmd).packages, (sub,))
        self.assertEqual(usage.inspect(self.root, 'sub/deep', ['bun test']).packages, (sub,))
        self.assertEqual(self.inspect('', steps=['cd sub && bun test', 'node x']).packages, (sub, self.root))

    def test_dependency_fields_empty_and_invalid(self):
        fields = ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies')
        for manifest in ({}, {k: {} for k in fields}):
            (self.root / 'package.json').write_text(json.dumps(manifest))
            self.assertEqual(self.inspect('node x').packages, ())
        for field in fields:
            (self.root / 'package.json').write_text(json.dumps({field: {'x': '1'}}))
            self.assertEqual(self.inspect('node x').packages, (self.root,))
        for manifest in ('{', '[]', 'null', '{"dependencies":null}'):
            (self.root / 'package.json').write_text(manifest)
            self.assertEqual(self.inspect('node x').packages, (self.root,))

    def test_install_options_before_subcommand(self):
        for command, install in (
            ('npm --ignore-scripts ci', 'npm ci'),
            ('npm --prefix sub ci', 'npm ci'),
            ('npm --registry=https://example.test i', 'npm i'),
            ('pnpm --offline install', 'pnpm install'),
            ('pnpm --dir sub i', 'pnpm i'),
            ('pnpm --filter @app/web install', 'pnpm install'),
            ('pnpm -F @app/web install', 'pnpm install'),
            ('pnpm --filter-prod @app/web i', 'pnpm i'),
            ('bun --frozen-lockfile install', 'bun install'),
            ('yarn --offline install', 'yarn install'),
            ('vp --verbose i', 'vp i'),
        ):
            with self.subTest(command=command):
                self.assertEqual(self.inspect(command).install, install)

    def test_comments_punctuation_and_wrapped_executable_paths(self):
        commands = (
            'python3 -V # check\ngo version',
            'python3 -V # check\n\ngo version',
            'python3 -V # check\r\ngo version',
            'true&&(go version);',
            'true;{ go version; }',
            'true &&(go version);',
            'true&&(gofmt -h);',
            'pnpm exec /usr/local/go/bin/go version',
            'pnpm exec ./tools/go version',
            'npx /usr/local/go/bin/gofmt -h',
            'corepack pnpm exec /usr/local/bin/gomobile version',
        )
        for command in commands:
            with self.subTest(command=command):
                self.assertTrue(self.inspect(command).needs_go)
        self.assertEqual(self.inspect('node -v # check\nnpm ci').install, 'npm ci')

    def test_comments_and_redirections_do_not_make_non_js_commands_use_js(self):
        commands = ('python3 -m unittest discover -s x/tests -v',
                    'X=1 python3 -m pytest x', 'pytest x', 'go test ./pkg', 'bash scripts/x.sh')
        suffixes = (' # check', ' # check\n', ' >output.log', ' >>output.log', ' 2>errors.log',
                    ' 2>&1', ' >output.log 2>&1', ' </dev/null', ' &>output.log')
        for command in commands:
            for suffix in suffixes:
                with self.subTest(command=command, suffix=suffix):
                    result = self.inspect(command + suffix)
                    self.assertFalse(result.uses_js)
                    self.assertEqual(result.packages, ())
                    if command.startswith(('go', 'bash')) or '>' in suffix or '<' in suffix:
                        self.assertTrue(result.needs_go)
        for command in ('node x', 'vp test run x', 'unknown-tool x'):
            for suffix in suffixes:
                self.assertTrue(self.inspect(command + suffix).uses_js, command + suffix)
        self.assertTrue(self.inspect('python3 x # comment\nnode x').uses_js)
        self.assertTrue(self.inspect('echo "#"; node x').uses_js)

    def test_literal_hashes_keep_later_commands_visible(self):
        for argument in ('https://example.test/#section', 'word#suffix', r'\#literal', "'#literal'", '"#literal"'):
            for tool, go, js in (('go test ./pkg', True, False), ('node x', False, True)):
                with self.subTest(argument=argument, tool=tool):
                    result = self.inspect(f'python3 check.py {argument}; {tool}')
                    self.assertEqual((result.needs_go, result.uses_js), (go, js))

    def test_redirections_preserve_separate_numeric_arguments(self):
        for command in ('timeout 30 >output.log python3 -m pytest',
                        'timeout 30 2>errors.log python3 -m pytest',
                        'timeout 30 2>&1 python3 -m pytest',
                        'timeout 30 >>output.log python3 -m pytest',
                        'timeout 30 <input.log python3 -m pytest',
                        'timeout 30 >output.log go test ./pkg'):
            with self.subTest(command=command):
                result = self.inspect(command)
                self.assertFalse(result.uses_js)
                self.assertTrue(result.needs_go)

    def test_comment_bodies_do_not_supply_substitutions_or_commands(self):
        for comment in ('$(echo ignored)', '`echo ignored`', 'go test ./pkg', 'node x', '"unterminated'):
            for separator in ('', '\n', '\r\n'):
                command = f'python3 -m pytest # {comment}{separator}'
                with self.subTest(command=command):
                    self.assertFalse(self.inspect(command).uses_js)
                    self.assertFalse(self.inspect(command).needs_go)
        self.assertTrue(self.inspect('python3 x # $(ignored)\nnode x').uses_js)

    def test_only_bash_whitespace_starts_comments(self):
        separators = (' ', '\t', '\n', '\r', '\v', '\f', '\x1c', '\x1d', '\x1e', '\x1f',
                      '\x85', '\u00a0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003',
                      '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200a',
                      '\u2028', '\u2029', '\u202f', '\u205f', '\u3000')
        for separator in separators:
            for tool in ('go version', 'node x'):
                with self.subTest(separator=repr(separator), tool=tool):
                    result = self.inspect(f'echo word{separator}#suffix; {tool}')
                    literal = separator not in ' \t\n'
                    self.assertEqual(result.needs_go, literal and tool.startswith('go'))
                    self.assertEqual(result.uses_js, literal and tool.startswith('node'))

    def test_nested_shell_comments_do_not_create_outer_substitutions(self):
        for shell in ('bash', 'sh', 'zsh', 'dash'):
            for option in ('-c', '-lc'):
                for comment in ('$(echo ignored)', '`echo ignored`'):
                    with self.subTest(shell=shell, option=option, comment=comment):
                        command = f"{shell} {option} 'python3 -m pytest # {comment}'"
                        result = self.inspect(command)
                        self.assertFalse(result.needs_go)
                        self.assertFalse(result.uses_js)
        for command in ('''bash -c 'python3 x' "$(go version)"''',
                        '''X="$(go version)" bash -c 'python3 x # ignored' ''',
                        '''uv --env-file "$(go version)" run python3 x''',
                        '''python3 x >"$(node -p process.version)"''',
                        '''bash -c "python3 x # $(go version)"''',
                        '''bash -c "python3 x # `go version`"'''):
            with self.subTest(command=command):
                result = self.inspect(command)
                self.assertTrue(result.needs_go)
                self.assertTrue(result.uses_js)

    def test_comment_uncertainty_keeps_nearest_zero_dependency_package(self):
        sub = self.root / 'sub'
        sub.mkdir()
        (sub / 'package.json').write_text('{}')
        for command in ('cd sub && node --test x.test.mjs # check',
                        'cd -P sub && node --test x.test.mjs # check',
                        'cd sub; node --test x.test.mjs # check\n',
                        'cd sub && node --test x.test.mjs # check\ncd .. && false'):
            with self.subTest(command=command):
                self.assertEqual(self.inspect(command).packages, ())

    def test_uv_directory_forms_select_effective_cwd_without_leaking(self):
        sub = self.root / 'sub'
        sub.mkdir()
        (sub / 'package.json').write_text('{}')
        forms = ('uv run --directory sub --no-project --offline node x',
                 'uv run --directory=sub node x',
                 'uv --directory sub run node x',
                 'uv --directory=sub run node x',
                 'uvx --directory sub node x',
                 'uvx --directory=sub node x')
        for command in forms:
            with self.subTest(command=command):
                self.assertEqual(self.inspect(command).packages, ())
                (sub / 'go.mod').touch()
                self.assertTrue(self.inspect(command).needs_go)
                (sub / 'go.mod').unlink()
                self.assertEqual(self.inspect(command + ' && node y').packages, (self.root,))
        (sub / 'package.json').write_text('{"devDependencies":{"x":"1"}}')
        self.assertEqual(self.inspect('uv run --directory sub node x && node y').packages, (sub, self.root))

    def test_pinned_corepack_commands_from_shared_install_hints(self):
        for command, install in (
            ('corepack pnpm@11.7.0 install --frozen-lockfile && vp test run x', 'pnpm install'),
            ('corepack yarn@4.9.2 install --immutable && node x', 'yarn install'),
            ('corepack pnpm@11.7.0 --filter @app/web i', 'pnpm i'),
            ('env X=1 timeout 30 corepack yarn@1.22.22 install', 'yarn install'),
        ):
            with self.subTest(command=command):
                result = self.inspect(command)
                self.assertFalse(result.needs_go)
                self.assertTrue(result.uses_js)
                self.assertEqual(result.install, install)

    def test_manager_directory_option_corpus(self):
        sub = self.root / 'sub dir'
        sub.mkdir()
        (sub / 'package.json').write_text('{"devDependencies":{"x":"1"}}')
        forms = ("pnpm --dir 'sub dir'", "pnpm --dir='sub dir'", "pnpm -C 'sub dir'",
                 "pnpm -C'sub dir'", "pnpm --filter @app/web --dir 'sub dir'",
                 "corepack pnpm@11.7.0 --dir 'sub dir'", "yarn --cwd 'sub dir'",
                 "yarn --cwd='sub dir'", "bun --cwd 'sub dir'", "bun --cwd='sub dir'",
                 "npm --prefix 'sub dir'", "npm --prefix='sub dir'")
        for prefix in forms:
            with self.subTest(prefix=prefix):
                self.assertEqual(self.inspect(prefix + ' test').packages, (sub,))
                self.assertFalse(self.inspect(prefix + ' test').needs_go)
                self.assertEqual(self.inspect(prefix + ' test && node x').packages, (sub, self.root))
                for manifest in ('go.mod', 'go.work'):
                    (sub / manifest).touch()
                    self.assertTrue(self.inspect(prefix + ' test').needs_go)
                    (sub / manifest).unlink()
                self.assertTrue(self.inspect(prefix + ' install').install.endswith(' install'))
        for command in ("pnpm install --dir 'sub dir'", "pnpm install -C'sub dir'",
                        "npm ci --prefix='sub dir'", "yarn install --cwd 'sub dir'",
                        "bun install --cwd='sub dir'", "npm test --prefix 'sub dir'",
                        "npm run test --prefix='sub dir'", "npm --silent run test --prefix 'sub dir'"):
            self.assertEqual(self.inspect(command).packages, (sub,), command)
            (sub / 'go.mod').touch()
            self.assertTrue(self.inspect(command).needs_go, command)
            (sub / 'go.mod').unlink()
        for command in ("npm test -- --prefix 'sub dir'", "npm run test -- --prefix='sub dir'"):
            self.assertEqual(self.inspect(command).packages, (self.root,), command)
        for prefix in ('pnpm --dir "$PACKAGE"', 'pnpm --dir', 'pnpm -C', 'pnpm --dir --offline test'):
            self.assertTrue(self.inspect(prefix).needs_go, prefix)

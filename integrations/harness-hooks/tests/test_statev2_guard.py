if __package__:
    from . import test_environment, code_mode_fixture, isolated_source_cases
else:
    import test_environment
    import code_mode_fixture
    import isolated_source_cases

from contextlib import redirect_stdout
from functools import wraps
import hashlib
import io
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import engine
import statev2_guard as guard
import claude
import codex

LIVE = "/Users/x/.robob/userdata/statev2.sqlite"
READ = "live-database-read"
SCRIPT = "live-database-script"
UNRESOLVED = "live-database-script-unresolved"
UNPROVED_REPORTERS = {
    'crpko-2697-source-and-test-heredocs.sh': 'python: non-isolated startup',
    'crpko-2738-terraform-append-node-test.sh': 'executable provenance or mutation proof failed',
    'crpko-2739-markdown-parity.sh': 'executable provenance or mutation proof failed',
    'crpko-2808-heredoc-relative-node-test.sh': 'python: non-isolated startup',
    'crpko-3096-facts-poll-ci.sh': 'python: non-isolated startup',
    'crpko-358-markdown-pytest.sh': 'python: non-isolated startup',
    'usdtwallet-162-s76-create-relative-python.sh': 'python: non-isolated startup',
    'usdtwallet-150-evidence.sh': 'python: non-isolated startup',
    'usdtwallet-143-verify.sh': 'python: non-isolated startup',
    'usdtwallet-140-proof-body-offbox.sh': 'command wrapper proof failed',
    'robob-712-heredoc-absolute-no-workdir.sh': 'python: non-isolated startup',
    'robob-649-test-source-unittest.sh': 'python: non-isolated startup',
    'crpko-69-native-fee-recovery.sh': 'python: non-isolated startup',
    'crpko-629-fee-override-tests.sh': 'python: non-isolated startup',
    'crpko-3096-poll-ci.sh': 'python: non-isolated startup',
    'crpko-3062-registry-edit.sh': 'python: non-isolated startup',
    'crpko-3057-test-ids.sh': 'python: non-isolated startup',
    'crpko-3022-create-run.sh': 'python: non-isolated startup',
    'crpko-2810-recovery-relative.sh': 'python: non-isolated startup',
    'crpko-2810-recovery-absolute.sh': 'python: non-isolated startup',
    'crpko-2774-cancel-probes.sh': 'python: non-isolated startup',
    'crpko-2590-verify-carry-ruby.sh': 'python: non-isolated startup',
    'crpko-2586-retained-json-create-relative-python.sh': 'python: non-isolated startup',
    'crpko-2574-json-tests.sh': 'python: non-isolated startup',
    'crpko-2471-dispatch-alert.sh': 'python: non-isolated startup',
    'crpko-2363-refine.sh': 'python: non-isolated startup',
    'crpko-2359-tests-budget.sh': 'python: non-isolated startup',
    'crpko-1606-append-relative-node-test.sh': 'python: non-isolated startup',
    'crpko-1606-otp-marker-node-check.sh': 'python: non-isolated startup',
    'crpko-3044-history-adoption.sh': 'python: non-isolated startup',
    'crpko-1606-terraform-create-offbox-node.sh': 'python: non-isolated startup',
    'usdtwallet-146-create-tests-offbox.sh': 'python: non-isolated startup',
}


def remote_only_offbox(command):
    """Test-side model of #221: the whole command is one `offbox run` that offbox
    can never hand back to the Mac (cli.py flags, several steps, or one quoted
    payload word holding a character fallback.allowed refuses)."""
    head, separator, payload = command.partition(' -- ')
    # An unquoted newline starts a second, local command.
    if '\n' in payload and not payload.startswith("'") or '\n' in head and '--step' not in head:
        return False

    def tokens(text):
        lexer = shlex.shlex(text, posix=True, punctuation_chars=';&|<>()')
        lexer.whitespace = ' \t'
        lexer.whitespace_split = True
        return list(lexer)

    try:
        words, argv = tokens(head), tokens(payload) if separator else []
    except ValueError:
        return False
    if words[:2] != ['offbox', 'run'] or any(set(word) <= set(';&|<>()\n') for word in words + argv):
        return False
    steps, index = 0, 2
    while index < len(words):
        flag = words[index].partition('=')[0]
        if flag in ('--bg', '--no-fallback', '--remote'):
            return True
        if flag == '--step':
            steps += 1
        if '=' not in words[index] and flag in ('--include', '--size', '--template', '--base', '--pull', '--env', '--step'):
            index += 1
        index += 1
    return steps > 1 or (len(argv) == 1 and payload.startswith("'") and
                         any(char in argv[0] for char in ';|&`$\n<>'))

def assert_verdict(test, command, cwd, expected):
    rule, reason = guard.classify_detail(command, str(cwd))
    test.assertEqual(rule, expected)
    if expected is None:
        test.assertIsNone(reason)
    else:
        test.assertTrue(reason)


# Reviewed @aikidosec/safe-chain 1.5.29 startup bytes; never executed here.
SAFE_CHAIN_INIT_POSIX = r'''if [ -n "${BASH_SOURCE[0]:-}" ]; then
    _sc_script_path="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_VERSION:-}" ]; then
    # ${(%):-%x} uses Zsh prompt expansion to get the sourced file's path.
    # eval is required so other shells don't try to parse the Zsh-specific syntax.
    eval '_sc_script_path="${(%):-%x}"'
else
    _sc_script_path="$0"
fi
_sc_scripts_dir=$(CDPATH= cd -- "$(dirname -- "$_sc_script_path")" 2>/dev/null && pwd -P)
_sc_base=$(dirname -- "$_sc_scripts_dir")
export PATH="$PATH:${_sc_base}/bin"
unset _sc_base _sc_script_path _sc_scripts_dir

function npx() {
  wrapSafeChainCommand "npx" "$@"
}

function yarn() {
  wrapSafeChainCommand "yarn" "$@"
}

function pnpm() {
  wrapSafeChainCommand "pnpm" "$@"
}

function pnpx() {
  wrapSafeChainCommand "pnpx" "$@"
}

function rush() {
  wrapSafeChainCommand "rush" "$@"
}

function rushx() {
  wrapSafeChainCommand "rushx" "$@"
}

function bun() {
  wrapSafeChainCommand "bun" "$@"
}

function bunx() {
  wrapSafeChainCommand "bunx" "$@"
}

function npm() {
  if [[ "$1" == "-v" || "$1" == "--version" ]] && [[ $# -eq 1 ]]; then
    # If args is just -v or --version and nothing else, just run the npm version command
    # This is because nvm uses this to check the version of npm
    command npm "$@"
    return
  fi

  wrapSafeChainCommand "npm" "$@"
}

function pip() {
  wrapSafeChainCommand "pip" "$@"
}

function pip3() {
  wrapSafeChainCommand "pip3" "$@"
}

function uv() {
  wrapSafeChainCommand "uv" "$@"
}

function uvx() {
  wrapSafeChainCommand "uvx" "$@"
}

function poetry() {
  wrapSafeChainCommand "poetry" "$@"
}

# `python -m pip`, `python -m pip3`.
function python() {
  wrapSafeChainCommand "python" "$@"
}

# `python3 -m pip`, `python3 -m pip3'.
function python3() {
  wrapSafeChainCommand "python3" "$@"
}

function pipx() {
  wrapSafeChainCommand "pipx" "$@"
}

function pdm() {
  wrapSafeChainCommand "pdm" "$@"
}

function printSafeChainWarning() {
  # \033[43;30m is used to set the background color to yellow and text color to black
  # \033[0m is used to reset the text formatting
  printf "\033[43;30mWarning:\033[0m safe-chain is not available to protect you from installing malware. %s will run without it.\n" "$1"
  # \033[36m is used to set the text color to cyan
  printf "Install safe-chain by using \033[36mnpm install -g @aikidosec/safe-chain\033[0m.\n"
}

function wrapSafeChainCommand() {
  local original_cmd="$1"

  if ! type -f "${original_cmd}" > /dev/null 2>&1; then
    # If the original command is not available, don't try to wrap it: invoke it
    # transparently, so the shell can report errors as if this wrapper didn't
    # exist.
    command "$@"
    return $?
  fi

  if command -v safe-chain > /dev/null 2>&1; then
    # If the aikido command is available, just run it with the provided arguments.
    # Unset PKG_EXECPATH so the yao-pkg bootstrap inside the safe-chain binary doesn't
    # mistake argv[1] for a script path and try to resolve it against cwd.
    (unset PKG_EXECPATH; safe-chain "$@")
  else
    # If the aikido command is not available, print a warning and run the original command
    printSafeChainWarning "$original_cmd"

    command "$@"
  fi
}
'''


def trusted_node_test(method):
    @wraps(method)
    def run(self):
        with self.trusted_node_environment():
            return method(self)
    return run


class RefusalGuidanceTests(unittest.TestCase):
    def test_recall_sqlite_detail_keeps_the_approved_route(self):
        command = ("sqlite3 -readonly 'file:/Users/ardud/.local/share/opencode/opencode.db?immutable=1' "
                   '"SELECT type,name,sql FROM sqlite_schema WHERE name IN (...)"')
        rule, cause = guard.classify_detail(command, '/tmp')
        self.assertEqual(rule, READ)
        self.assertIn('line 1 names', cause)
        self.assert_guidance(rule, cause)

    def test_inline_python_detail_keeps_the_approved_route(self):
        source = 'import sqlite3\n' + '# context\n' * 7 + "sqlite3.connect('/Users/ardud/.local/share/opencode/opencode.db')\n"
        rule, cause = guard.classify_detail("python3 -I - <<'EOF'\n" + source + 'EOF', '/tmp')
        self.assertEqual(rule, READ)
        self.assertIn('<inline script>:9 names', cause)
        self.assert_guidance(rule, cause)

    def assert_guidance(self, rule, cause):
        reason = guard.refusal_reason(rule, cause, '/tmp')
        tail = guard.REASON.partition('\n')[2]
        self.assertEqual(reason, 'statev2 guard: this command was NOT run.\n' + cause + '\n' + tail)
        self.assertIn('live-db-snapshot --card <id> --ask <id> --db <path>', reason)

    def test_only_live_database_detail_rules_append_guidance(self):
        for rule in [READ, SCRIPT]:
            with self.subTest(rule=rule):
                self.assert_guidance(rule, 'line 1 names opencode.db.')
        for rule in ['live-database-snapshot', 'live-database-unavailable', 'other-rule']:
            with self.subTest(rule=rule):
                self.assertEqual(guard.refusal_reason(rule, 'existing detail', '/tmp'),
                                 'statev2 guard: this command was NOT run.\nexisting detail')

    def test_no_cause_policy_is_byte_identical(self):
        self.assertEqual(hashlib.sha256(guard.REASON.encode()).hexdigest(),
                         '1683e7c85b2292019767ab04fbf800f2aed028d62b9e74718b5adf1625de463f')
        for rule in [READ, SCRIPT]:
            with self.subTest(rule=rule):
                self.assertEqual(guard.refusal_reason(rule, None, '/tmp'), guard.REASON)

    def test_unresolved_messages_are_byte_identical(self):
        snapshots = {
            'script source changed after its heredoc write':
                'Could not check script source changed after its heredoc write. Resolved workdir: /tmp.\n'
                'An intervening command may replace the checked source. Split source preparation and execution into separate calls.',
            'node: repo-node-pin invalid':
                'Could not check node: repo-node-pin invalid. Resolved workdir: /tmp.\n'
                'Resolve the named startup input, then retry.',
            'python3: bare executable lookup unproved; missing pin\nAccepted: use a literal path':
                'Could not check python3: bare executable lookup unproved; missing pin. Resolved workdir: /tmp.\n'
                'Accepted: retry this same call with /usr/bin/python3 -I … instead of bare python3; '
                'the executable, startup and mutation checks still apply.',
        }
        for cause, snapshot in snapshots.items():
            with self.subTest(cause=cause):
                self.assertEqual(guard.refusal_reason(UNRESOLVED, cause, '/tmp'),
                                 'statev2 guard: this command was NOT run.\n' + snapshot)


class GuardTests(unittest.TestCase):
    def setUp(self):
        clean = isolated_source_cases.fixture_environment_patch()
        clean.start()
        self.addCleanup(clean.stop)
        lookup = patch.dict(os.environ, {'PATH': os.pathsep.join(('/usr/bin', '/bin', os.environ['PATH']))})
        lookup.start()
        self.addCleanup(lookup.stop)
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

    def heredoc(self, target, body, append=False):
        return ('cat >> ' if append else 'cat > ') + target + " <<'GUARD_BODY'\n" + body.rstrip() + '\nGUARD_BODY\n'

    trusted_node_environment = staticmethod(isolated_source_cases.trusted_node_environment)

    def reporter_body(self, name):
        return (Path(__file__).with_name('fixtures') / 'heredoc-rerun' / name).read_text()

    def test_checked_intervening_reporters(self):
        with self.trusted_node_environment():
            fixtures = Path(__file__).with_name('fixtures') / 'checked-intervening'
            sources = json.loads((fixtures / 'sources.json').read_text())
            for row in json.loads((fixtures / 'cases.json').read_text()):
                directory = self.root / row['fixture']
                directory.mkdir()
                for group, entries in sources.items():
                    if row['fixture'].startswith(group):
                        for entry in entries:
                            target = directory / entry['path']
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.write_text((fixtures / entry['snapshot']).read_text())
                command = (fixtures / row['fixture']).read_text().replace(row['cwd'], str(directory))
                with self.subTest(reporter=row['fixture'], shape=row['label']):
                    rule, cause = guard.classify_detail(command, str(directory))
                    if row['fixture'] in {'crpko4308-guard-1.sh', 'crpko4308-guard-3.sh', 'crpko4308-guard-5.sh', 'crpko4308-guard-6.sh'}:
                        self.assertEqual(rule, UNRESOLVED, cause)
                        self.assertIn('executable provenance or mutation proof failed', cause)
                    elif row['fixture'] in {
                        'crpko4156-guard-1.sh',
                        'crpko4156-guard-2.sh',
                        'crpko4156-guard-5.sh',
                        'crpko4364-exact.sh',
                        'mac40-guard-1.sh',
                        'mac40-guard-2.sh',
                        'mac40-guard-5.sh',
                        'mac54-guard-2.sh',
                        'mac54-guard-4.sh',
                        'offbox129-guard-6.sh',
                        'offbox129-guard-7.sh',
                        'recall52-discover-11.sh',
                        'recall52-discover-3.sh',
                        'torssh21-guard-2.sh',
                        'torssh21-guard-4.sh',
                        'torssh21-guard-6.sh',
                        'torssh21-guard-8.sh',
                    }:
                        self.assertEqual(rule, UNRESOLVED, cause)
                        self.assertRegex(cause, 'non-isolated startup|module startup unproved|command wrapper proof failed|executable provenance or mutation proof failed')
                    elif row['expected'] == 'allow':
                        self.assertIsNone(rule, cause)
                    else:
                        self.assertIsNotNone(rule)
                    if row.get('script'):
                        self.assertEqual(rule, UNRESOLVED)
                        self.assertTrue(row['script'] in cause or 'interpreter startup:' in cause, cause)
                        reason = guard.refusal_reason(rule, cause, str(directory))
                        self.assertIn('Split source preparation and execution into separate calls', reason)
                        self.assertNotIn('literal absolute', reason)

    def test_checked_intervening_writers(self):
        target = 'tmp/checked.py'
        prefix = self.heredoc(target, 'print(1)')
        run = 'python3 -I ' + target
        bodies = [
            f"from pathlib import Path\np=Path({target!r});p.write_text('print(2)')",
            f"open({target!r}, 'w').write('print(2)')",
            f"import os\nos.replace('replacement.py', {target!r})",
            "from pathlib import Path\nimport sys\nPath(sys.argv[1]).write_text('print(2)')",
            "import ast\nast.parse(open('other.py').read());open('tmp/checked.py', 'w').write('print(2)')",
            "from pathlib import Path\np=Path('tmp/sibling.py')\nif flag: p=Path('tmp/checked.py')\np.write_text('print(2)')",
        ]
        commands = ["python3 -I - <<'EDIT'\n" + body + '\nEDIT\n' for body in bodies]
        commands += [f'cat other.py > {target}\n', f'cat other.py >> {target}\n',
                     f'cp other.py {target}\n', f'mv other.py {target}\n',
                     f'sed -i s/1/2/ {target}\n', f'git checkout HEAD -- {target}\n']
        for change in commands:
            with self.subTest(change=change):
                command = prefix + change + run
                rule, cause = guard.classify_detail(command, str(self.root))
                self.assertEqual(rule, UNRESOLVED, cause)
                reason = guard.refusal_reason(rule, cause, str(self.root))
                self.assertIn('Split source preparation and execution into separate calls', reason)
                self.assertNotIn('literal absolute', reason)
                self.adapters(command, UNRESOLVED)

    def test_checked_intervening_parsing_and_sibling_edits(self):
        target = 'tmp/checked.py'
        changes = [
            "from pathlib import Path\nimport ast\nfor p in ['tmp/checked.py']: ast.parse(Path(p).read_text())",
            "from pathlib import Path\np=Path('tmp/sibling.py');s=p.read_text();s=s[:s.index('x')]+s;s=s.replace('a','b');compile(s,str(p),'exec');p.write_text(s)",
            "from pathlib import Path\np=Path('tmp/sibling.py');p.write_text(p.read_text().replace('a','b'))",
        ]
        for body in changes:
            with self.subTest(body=body):
                command = self.heredoc(target, 'print(1)') + "python3 -I - <<'EDIT'\n" + body + '\nEDIT\npython3 -I ' + target
                self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))
                self.adapters(command)

    def test_checked_intervening_syntax_checks(self):
        with self.trusted_node_environment():
            for flag in ['--check', '-c']:
                prefix = self.heredoc('tmp/checked.mjs', 'console.log(1)')
                run = 'node tmp/checked.mjs'
                command = prefix + f'node {flag} tmp/checked.mjs\n' + run
                with self.subTest(flag=flag):
                    self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))
                    self.adapters(command)
                for check in [f'node --require tmp/hook.cjs {flag} tmp/checked.mjs',
                              f'node --import tmp/hook.mjs {flag} tmp/checked.mjs',
                              f'NODE_OPTIONS=--require=./tmp/hook.cjs node {flag} tmp/checked.mjs']:
                    with self.subTest(check=check):
                        self.assertEqual(self.classify(prefix + check + '\n' + run), UNRESOLVED)
            startup = self.write('startup.sh', "echo replacement > tmp/checked.py")
            prefix = self.heredoc('tmp/checked.py', 'print(1)')
            with patch.dict(os.environ, {'BASH_ENV': str(startup)}):
                command = prefix + 'bash -n tmp/checked.py\npython3 -I tmp/checked.py'
                rule, cause = guard.classify_detail(command, str(self.root))
                self.assertEqual(rule, UNRESOLVED, cause)
                self.assertIn('BASH_ENV: expected ', cause)
                self.assertIn(str(Path.home() / '.local/libexec/repo-node-pin/bash-env.sh'), cause)
            with patch.dict(os.environ, {'BASH_FUNC_node%%': "() { printf 'print(2)\\n' > tmp/checked.py; }"}):
                command = prefix + self.heredoc('tmp/checked.mjs', 'console.log(1)')
                command += 'node --check tmp/checked.mjs\npython3 -I tmp/checked.py'
                self.assertEqual(self.classify('bash -c ' + shlex.quote(command)), UNRESOLVED)

    def test_checked_intervening_node_identity(self):
        prefix = self.heredoc('tmp/checked.py', 'print(1)')
        prefix += self.heredoc('tmp/checked.mjs', 'console.log(1)')
        writer = "#!/bin/sh\nprintf '%s\\n' 'print(2)' > tmp/checked.py"
        for executable in ['./tmp/node', str(self.root / 'tmp/node')]:
            command = prefix + self.heredoc('tmp/node', writer) + 'chmod +x tmp/node\n'
            command += executable + ' --check tmp/checked.mjs\npython3 -I tmp/checked.py'
            with self.subTest(executable=executable):
                self.assertEqual(self.classify(command), UNRESOLVED)
        shadow = self.write('bin/node', writer)
        shadow.chmod(0o755)
        with patch.dict(os.environ, {'PATH': str(shadow.parent) + os.pathsep + os.environ['PATH']}):
            self.assertEqual(self.classify(prefix + 'node --check tmp/checked.mjs\npython3 -I tmp/checked.py'), UNRESOLVED)
        startup = self.write('untrusted-startup.sh', 'echo startup')
        shell = self.write('bin/bash', writer)
        shell.chmod(0o755)
        with patch.dict(os.environ, {'BASH_ENV': str(startup)}):
            for executable in ['./bin/bash', str(shell)]:
                with self.subTest(executable=executable):
                    self.assertEqual(self.classify(prefix + executable + ' -n tmp/checked.py\npython3 -I tmp/checked.py'), UNRESOLVED)
            with patch.dict(os.environ, {'PATH': str(shell.parent) + os.pathsep + os.environ['PATH']}):
                self.assertEqual(self.classify(prefix + 'bash -n tmp/checked.py\npython3 -I tmp/checked.py'), UNRESOLVED)

    def test_checked_intervening_system_tool_ownership(self):
        node = Path('/usr/local/bin/node')
        chain = (node, *node.parents)
        actual_stat, realpath = os.stat, os.path.realpath
        command = self.heredoc('tmp/checked.mjs', 'console.log(1)')
        command += '/usr/local/bin/node --check tmp/checked.mjs\nnode tmp/checked.mjs'
        cases = [('root-owned chain', None, 0, 0o755, None)]
        cases += [(str(part) + label, part, uid, mode, None) for part in chain
                  for label, uid, mode in [(' user-owned', 501, 0o755), (' group-writable', 0, 0o775), (' world-writable', 0, 0o757)]]
        cases += [('stat error', node, 0, 0o755, PermissionError('unavailable'))]
        for label, unsafe, uid, mode, error in cases:
            def metadata(path, *args, **kwargs):
                part = Path(path)
                if part in chain:
                    if part == unsafe and error:
                        raise error
                    owner, permissions = (uid, mode) if part == unsafe else (0, 0o755)
                    kind = stat.S_IFREG if part == node else stat.S_IFDIR
                    return os.stat_result((kind | permissions, 0, 0, 1, owner, 0, 0, 0, 0, 0))
                return actual_stat(path, *args, **kwargs)
            with self.subTest(ownership=label), patch.object(os, 'stat', side_effect=metadata), patch.object(os.path, 'realpath', side_effect=lambda path, *a, **k: str(node) if str(path) == str(node) else realpath(path, *a, **k)):
                self.assertEqual(self.classify(command), None if unsafe is None else UNRESOLVED)

    def test_checked_intervening_mac_node_resolution(self):
        home = Path('/Users/ardud')
        fixtures = Path(__file__).with_name('fixtures') / 'checked-intervening'
        fixture = 'crpko4201-node-check-1.sh'
        row = next(row for row in json.loads((fixtures / 'cases.json').read_text()) if row['fixture'] == fixture)
        for group, entries in json.loads((fixtures / 'sources.json').read_text()).items():
            if fixture.startswith(group):
                for entry in entries:
                    self.write(entry['path'], (fixtures / entry['snapshot']).read_text())
        command = (fixtures / fixture).read_text().replace(row['cwd'], str(self.root))
        rows = [
            ('Hermes symlink', str(home / '.local/bin/node'), '/Volumes/ExternalSSD/migrated/hermes/node/bin/node', False),
            ('NVM 24', str(home / '.nvm/versions/node/v24.22.3/bin/node'), str(home / '.nvm/versions/node/v24.22.3/bin/node'), True),
            ('NVM 26', str(home / '.nvm/versions/node/v26.13.0/bin/node'), str(home / '.nvm/versions/node/v26.13.0/bin/node'), True),
            ('NVM symlink', str(home / '.local/bin/node'), str(home / '.nvm/versions/node/v26.13.0/bin/node'), True),
            ('Homebrew symlink', '/opt/homebrew/bin/node', '/opt/homebrew/Cellar/node/26.13.0_2/bin/node', True),
        ]
        realpath, which = os.path.realpath, guard.shutil.which
        for label, executable, resolved, trusted in rows:
            def resolve(path, *args, **kwargs):
                return resolved if str(path) == executable else realpath(path, *args, **kwargs)
            def lookup(name, *args, **kwargs):
                return executable if name == 'node' else which(name, *args, **kwargs)
            with self.subTest(toolchain=label), patch.object(Path, 'home', return_value=home), patch.dict(os.environ, {'PATH': os.pathsep.join((str(Path(executable).parent), '/usr/bin', '/bin'))}), patch.object(os.path, 'realpath', side_effect=resolve), patch.object(guard.shutil, 'which', side_effect=lookup):
                self.assertEqual(guard._trusted_fixture_tool(executable, 'node', self.root), trusted)
                self.assertEqual(guard._trusted_fixture_tool('node', 'node', self.root), trusted)
                rule, cause = guard.classify_detail(command, str(self.root))
                self.assertEqual(rule, None if trusted else UNRESOLVED, cause)
                if not trusted:
                    self.assertRegex(cause, r'kafka-acl-probes.mjs|execution parse-only')
                    self.assertIn('executable provenance or mutation proof failed', cause)

    def test_checked_intervening_tool_mutations(self):
        home = (self.root / 'home').resolve()
        node = self.write('home/.nvm/versions/node/v26.0.0/bin/node', '#!/bin/sh\nexit 0\n').resolve()
        node.chmod(0o755)
        symlink = self.root / 'node-symlink'
        symlink.symlink_to(node)
        hardlink = self.root / 'node-hardlink'
        os.link(node, hardlink)
        prefix = self.heredoc('tmp/checked.py', 'print(1)') + self.heredoc('tmp/checked.mjs', 'console.log(1)')
        writer = '#!/bin/sh\ncp tmp/replacement.py tmp/checked.py\n'
        edits = {
            'heredoc': self.heredoc(str(node), writer),
            'redirect': f'cat tmp/replacement.sh > {node}\n',
            'append': f'cat tmp/replacement.sh >> {node}\n',
            'tee': f'tee {node} <<\'EDIT\'\n{writer}EDIT\n',
            'stdin write_text': "python3 -I - <<'EDIT'\nfrom pathlib import Path\n" + f'Path({str(node)!r}).write_text({writer!r})\nEDIT\n',
            'stdin open': "python3 -I - <<'EDIT'\n" + f'open({str(node)!r}, "w").write({writer!r})\nEDIT\n',
            'copy': f'cp tmp/replacement.sh {node}\n',
            'move': f'mv tmp/replacement.sh {node}\n',
            'sed': f'sed -i s/exit/cp/ {node}\n',
            'replace directory': f'mv tmp/bin {node.parent}\n',
            'replace link': f'ln -sf tmp/replacement.sh {node}\n',
            'symlink alias': self.heredoc(str(symlink), writer),
            'hardlink alias': self.heredoc(str(hardlink), writer),
            'shell child': 'sh -c ' + shlex.quote(f'cat tmp/replacement.sh > {node}') + '\n',
            'PATH binding': f'PATH={node.parent}:$PATH\n',
            'unset PATH': 'unset PATH\n',
            'shell alias': "alias node='cp tmp/replacement.py tmp/checked.py'\n",
            'shell function': 'node() { cp tmp/replacement.py tmp/checked.py; }\n',
            'hash binding': f'hash -p {node} node\n',
        }
        for template in ('', ' invalid', ' /missing/probe.XXXXXX', ' -t probe.XXXXXX'):
            setup = 'd=$(mktemp -d' + template + ')\n'
            target = '"$d' + str(node) + '"'
            edits['fresh-root heredoc fallback' + template] = setup + self.heredoc(target, writer)
            edits['fresh-root copy fallback' + template] = setup + 'cp tmp/replacement.sh ' + target + '\n'
        with patch.object(Path, 'home', return_value=home), patch.dict(os.environ, {'PATH': str(node.parent) + os.pathsep + os.environ['PATH']}):
            self.assertTrue(guard._trusted_fixture_tool(str(node), 'node', self.root))
            self.assertEqual(self.classify(prefix + 'node --check tmp/checked.mjs\npython3 -I tmp/checked.py'), None)
            for executable in [str(node), 'node']:
                for label, edit in edits.items():
                    command = prefix + edit + executable + ' --check tmp/checked.mjs\npython3 -I tmp/checked.py'
                    with self.subTest(executable=executable, mutation=label):
                        rule, cause = guard.classify_detail(command, str(self.root))
                        self.assertEqual(rule, UNRESOLVED, cause)
                        self.assertRegex(cause, r'tmp/checked.py|execution parse-only|interpreter startup:')
                        self.adapters(command, UNRESOLVED)
            for label, command in {
                'mutation before script creation': edits['heredoc'] + prefix + 'node --check tmp/checked.mjs\npython3 -I tmp/checked.py',
                'opaque before script creation': 'unknown-program\n' + prefix + 'node --check tmp/checked.mjs\npython3 -I tmp/checked.py',
                'offbox payload': prefix + edits['stdin write_text'] + "offbox run -- 'node --check tmp/checked.mjs; python3 -I tmp/checked.py'",
                'bash executable': prefix + self.heredoc('/bin/bash', writer) + '/bin/bash -n tmp/checked.mjs\npython3 -I tmp/checked.py',
            }.items():
                # The ';' payload would be remote-only (#221), but this cwd holds
                # the patched home, and offbox syncs cwd outside git, so the
                # live directory would leave the Mac: full checks stay.
                expected = UNRESOLVED
                with self.subTest(mutation=label):
                    self.assertEqual(self.classify(command), expected)
                    self.adapters(command, expected)
            # One argv the box may hand back to the Mac keeps the proof.
            command = prefix + edits['stdin write_text'] + 'offbox run -- python3 -I tmp/checked.py'
            with self.subTest(mutation='offbox fallback payload'):
                self.assertEqual(self.classify(command), UNRESOLVED)
            shadow = self.write('shadow/node', writer)
            shadow.chmod(0o644)
            shadow_link = self.root / 'shadow-hardlink'
            os.link(shadow, shadow_link)
            edits = {
                'create PATH shadow': self.heredoc(str(shadow), writer),
                'enable PATH shadow': f'chmod +x {shadow}\n',
                'enable PATH shadow through hardlink': f'chmod +x {shadow_link}\n',
                'stdin PATH shadow': "python3 -I - <<'EDIT'\nfrom pathlib import Path\n" + f'Path({str(shadow)!r}).write_text({writer!r})\nEDIT\n',
            }
            with patch.dict(os.environ, {'PATH': str(shadow.parent) + os.pathsep + os.environ['PATH']}):
                for label, edit in edits.items():
                    with self.subTest(resolution=label):
                        command = prefix + edit + 'node --check tmp/checked.mjs\npython3 -I tmp/checked.py'
                        self.assertEqual(self.classify(command), UNRESOLVED)
                        self.adapters(command, UNRESOLVED)

    def test_checked_intervening_constructor_shadowing(self):
        bindings = {
            'match': 'match pick:\n case Path: pass',
            'match sequence': 'match [pick]:\n case [Path]: pass',
            'assignment': 'Path=pick',
            'loop': 'for Path in [pick]: pass',
            'function': "def Path(p): return pathlib.Path('tmp/checked.py')",
            'import alias': 'from pathlib import PurePath as Path',
        }
        for label, binding in bindings.items():
            body = "compile('pass', 'x', 'exec')\nimport pathlib\ndef pick(p): return pathlib.Path('tmp/checked.py')\n"
            body += binding + "\nPath('tmp/sibling.py').write_text('print(2)')"
            command = self.heredoc('tmp/checked.py', 'print(1)')
            command += "python3 -I - <<'EDIT'\n" + body + '\nEDIT\npython3 -I tmp/checked.py'
            with self.subTest(binding=label):
                self.assertEqual(self.classify(command), UNRESOLVED)
                self.adapters(command, UNRESOLVED)

    def test_checked_intervening_parser_shadowing(self):
        bodies = [
            "from pathlib import Path\ncompile=Path('tmp/checked.py').write_text\ncompile('print(2)')",
            "from pathlib import Path\ndef edit(compile): compile('print(2)')\nedit(Path('tmp/checked.py').write_text)",
            "from pathlib import Path\nimport ast\nast.parse(Path('tmp/checked.py').write_text('print(2)'))",
            "from pathlib import Path\ncompile(Path('tmp/checked.py').write_text('print(2)'), 'x', 'exec')",
            "match open:\n case compile: compile('tmp/checked.py', 'w')",
            "match [open]:\n case [compile]: compile('tmp/checked.py', 'w')",
            "match {'x': open}:\n case {'x': compile}: compile('tmp/checked.py', 'w')",
            "match [open]:\n case [*compile]: compile[0]('tmp/checked.py', 'w')",
            "match {'x': open}:\n case {**compile}: compile['x']('tmp/checked.py', 'w')",
            "from builtins import open as compile\ncompile('tmp/checked.py', 'w')",
        ]
        for body in bodies:
            command = self.heredoc('tmp/checked.py', 'print(1)') + "python3 -I - <<'EDIT'\n" + body + '\nEDIT\npython3 -I tmp/checked.py'
            with self.subTest(body=body):
                self.assertEqual(self.classify(command), UNRESOLVED)

        for builtin in ('len', 'str', 'int', 'set', 'dict', 'list', 'tuple', 'print', 'sorted', 'range', 'all', 'any', 'min', 'max'):
            body = "compile('pass','x','exec')\nmatch open:\n case " + builtin + ": pass\n" + builtin + "('tmp/checked.py','w')"
            command = self.heredoc('tmp/checked.py', 'print(1)') + "python3 -I - <<'EDIT'\n" + body + '\nEDIT\npython3 -I tmp/checked.py'
            with self.subTest(captured_builtin=builtin):
                self.assertEqual(self.classify(command), UNRESOLVED)
                self.adapters(command, UNRESOLVED)

    def test_checked_intervening_retained_writers(self):
        prefix = self.heredoc('tmp/checked.py', 'print(1)')
        prefix += "python3 -I - <<'CHECK'\nimport ast\nast.parse(open('tmp/checked.py').read())\nCHECK\n"
        prefix += self.heredoc('tmp/editor.py', "match open:\n case len: pass\nlen('tmp/checked.py', 'w')")
        for invoke in ('python3 -I tmp/editor.py', 'python3 -I ' + str(self.root / 'tmp/editor.py'),
                       'python3 -I -m unittest discover -s tmp -p editor.py'):
            command = prefix + invoke + '\npython3 -I tmp/checked.py'
            with self.subTest(invoke=invoke):
                self.assertEqual(self.classify(command), UNRESOLVED)
                self.adapters(command, UNRESOLVED)

    def test_checked_intervening_rebinding_scopes(self):
        replacements = {
            'for': "for s in [Path('tmp/replacement.py')]:\n s.replace('tmp/checked.py')",
            'while': "while flag:\n s=Path('tmp/replacement.py')\n s.replace('tmp/checked.py')",
            'if': "if flag:\n s=Path('tmp/replacement.py')\n s.replace('tmp/checked.py')",
            'with': "with Path('tmp/replacement.py') as s:\n s.replace('tmp/checked.py')",
            'try': "try:\n s=Path('tmp/replacement.py')\n s.replace('tmp/checked.py')\nexcept Exception: pass",
            'except target': "try: pass\nexcept Exception as s:\n s.replace('tmp/checked.py')",
            'match': "match other:\n case s: s.replace('tmp/checked.py')",
            'parameter': "def edit(s):\n s.replace('tmp/checked.py')\nedit(Path('tmp/replacement.py'))",
            'function name': "def s(): pass\ns.replace('tmp/checked.py')",
            'class name': "class s: pass\ns.replace('tmp/checked.py')",
            'annotated': "s: object=Path('tmp/replacement.py')\ns.replace('tmp/checked.py')",
            'unpacked': "s, = [Path('tmp/replacement.py')]\ns.replace('tmp/checked.py')",
            'chained': "s=other=Path('tmp/replacement.py')\ns.replace('tmp/checked.py')",
            'walrus': "(s:=Path('tmp/replacement.py')).replace('tmp/checked.py')",
            'comprehension': "[s.replace('tmp/checked.py') for s in [Path('tmp/replacement.py')]]",
            'assigned comprehension': "out=[s.replace('tmp/checked.py') for s in [Path('tmp/replacement.py')]]",
            'import alias': "import os as s\ns.replace('tmp/replacement.py', 'tmp/checked.py')",
            'from import alias': "from pathlib import os as s\ns.replace('tmp/replacement.py', 'tmp/checked.py')",
            'match mapping rest': "match {'x': Path('tmp/replacement.py')}:\n case {**s}: s['x'].replace('tmp/checked.py')",
        }
        prefix = self.heredoc('tmp/checked.py', 'print(1)')
        prefix += self.heredoc('tmp/replacement.py', f'open({LIVE!r}).read()')
        for label, replacement in replacements.items():
            body = "from pathlib import Path\ns=Path('tmp/checked.py').read_text()\n" + replacement
            command = prefix + "python3 -I - <<'EDIT'\n" + body + '\nEDIT\npython3 -I tmp/checked.py'
            with self.subTest(binding=label):
                self.assertEqual(self.classify(command), UNRESOLVED)
                self.adapters(command, UNRESOLVED)

    def adapters(self, command, expected=None, expected_reason=None):
        for harness, adapter, tool, field in [('claude', claude, 'Bash', 'command'), ('codex', codex, 'exec_command', 'cmd')]:
            event = {'hook_event_name': 'PreToolUse', 'cwd': str(self.root), 'tool_name': tool,
                     'tool_input': {field: command}}
            with self.subTest(harness=harness), patch.object(engine, '_log'), patch.object(engine, '_tool_log'), \
                    patch.object(engine, '_offbox_mode', return_value='off'), \
                    patch.object(engine, '_native', return_value=(None, None, None)), \
                    patch.dict(os.environ, {name: '' for name in (engine.COMMAND_IDENTITY_ENV, 'AGENT_GUARD_APPROVED', 'HARNESS_COORD_APPROVED')}):
                result = engine.decide(event, harness)
                self.assertEqual(result['decision'], 'deny' if expected else 'allow', result)
                if expected_reason:
                    self.assertIn(expected_reason, result['reason'])
                if expected:
                    self.assertEqual(result['context']['rule'], expected)
                with patch.object(sys, 'stdin', io.StringIO(json.dumps(event))), redirect_stdout(io.StringIO()) as output:
                    adapter.main()
                if expected:
                    self.assertEqual(json.loads(output.getvalue())['hookSpecificOutput']['permissionDecision'], 'deny')
                    if expected_reason:
                        self.assertIn(expected_reason, json.loads(output.getvalue())['hookSpecificOutput']['permissionDecisionReason'])
                else:
                    self.assertEqual(output.getvalue(), '')

    @trusted_node_test
    def test_same_call_literal_sibling_edits(self):
        self.write('config/shards.json', '{}')
        edits = [
            "from pathlib import Path\ns=open('config/shards.json').read()\nPath('config/shards.json').write_text(s)",
            "import json\ns=json.load(open('config/shards.json'))\njson.dump(s, open('config/shards.json', 'w'))",
            "import json\nwith open('config/shards.json', 'w') as f:\n json.dump({}, f)",
        ]
        for body in edits:
            command = self.heredoc('scripts/a.mjs', 'console.log(1)', append=True)
            command += "python3 -I - <<'PY'\n" + body + '\nPY\nnode --test scripts/a.mjs'
            with self.subTest(body=body):
                self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))
                self.adapters(command)

    @trusted_node_test
    def test_same_call_python_provenance_retry_hint(self):
        hint = ('Accepted: retry this same call with /usr/bin/python3 -I … instead of bare python3; '
                'the executable, startup and mutation checks still apply.')
        shadow = self.write('shadow-bin/python3', '#!/bin/sh\necho WRAPPER_MUST_NOT_RUN\n')
        shadow.chmod(0o755)
        self.write('config/sibling.txt', 'old')
        shapes = {
            'case3': ('d=$(mktemp -d)\n'
                      'PYTHON -I -c \'print("PRIVATE_CODE (( ${t.name}")\'\n' +
                      self.heredoc('"$d/x.mjs"', 'console.log(1)') + 'node "$d/x.mjs"'),
            '4504': (self.heredoc('scripts/a.mjs', 'console.log(1)', append=True) +
                     "PYTHON -I - <<'EDIT'\nfrom pathlib import Path\n"
                     "Path('config/sibling.txt').write_text('new')\nEDIT\nnode --test scripts/a.mjs"),
            'script': ('d=$(mktemp -d)\n' + self.heredoc('"$d/port.py"', 'print(1)') +
                       'PYTHON -I "$d/port.py"'),
        }
        with patch.dict(os.environ, {'PATH': str(shadow.parent) + os.pathsep + os.environ['PATH']}):
            for label, shape in shapes.items():
                for python in ('python3', 'command python3'):
                    command = shape.replace('PYTHON', python)
                    with self.subTest(shape=label, python=python):
                        rule, cause = guard.classify_detail(command, str(self.root))
                        self.assertEqual(rule, UNRESOLVED, cause)
                        self.assertIn('python3: executable provenance or mutation proof failed', cause)
                        reason = guard.refusal_reason(rule, cause, str(self.root))
                        self.assertIn(hint, reason)
                        self.assertEqual(reason.count('Accepted:'), 1)
                        self.assertNotIn('PRIVATE_CODE', reason)
                        self.assertNotIn('WRAPPER_MUST_NOT_RUN', reason)
                        self.adapters(command, UNRESOLVED, expected_reason=hint)
                command = shape.replace('PYTHON', '/usr/bin/python3')
                with self.subTest(shape=label, python='absolute'):
                    self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))
                    self.adapters(command)

    @trusted_node_test
    def test_same_call_python_retry_preserves_refusals(self):
        writer = self.heredoc('scripts/a.mjs', 'console.log(1)')
        rows = {
            'checked source write': writer + "/usr/bin/python3 -I - <<'EDIT'\n"
                                    "from pathlib import Path\nPath('scripts/a.mjs').write_text('changed')\n"
                                    'EDIT\nnode --test scripts/a.mjs',
            'binary mutation': writer + 'cp replacement /usr/bin/python3\n'
                               "/usr/bin/python3 -I -c 'print(1)'\nnode --test scripts/a.mjs",
            'non-isolated': writer + "/usr/bin/python3 -c 'print(1)'\nnode --test scripts/a.mjs",
            'live read': writer + "/usr/bin/python3 -I -c " + shlex.quote(f'open({LIVE!r}).read()') +
                         '\nnode --test scripts/a.mjs',
            'arbitrary function': writer + 'python3() { echo changed; }\n'
                                  "python3 -I -c 'print(1)'\nnode --test scripts/a.mjs",
        }
        for label, command in rows.items():
            with self.subTest(case=label):
                rule, cause = guard.classify_detail(command, str(self.root))
                self.assertIsNotNone(rule, cause)
                self.assertNotIn('instead of bare python3', guard.refusal_reason(rule, cause, str(self.root)))
                self.adapters(command, rule)

        for predecessor in ('opaque-mutator', "sed 's/a/b/e' config/sibling.txt",
                            "python3 -c 'print(1)'", "perl -e 'print 1'"):
            command = writer + predecessor + "\n/usr/bin/python3 -I -c 'print(1)'\nnode scripts/a.mjs"
            with self.subTest(predecessor=predecessor):
                rule, cause = guard.classify_detail(command, str(self.root))
                self.assertEqual(rule, UNRESOLVED, cause)
                reason = guard.refusal_reason(rule, cause, str(self.root))
                self.assertNotIn('instead of bare python3', reason)
                self.assertIn('Split source preparation and execution into separate calls', reason)
                self.adapters(command, rule, expected_reason='Split source preparation and execution into separate calls')

        for marker in ('python3: executable provenance or mutation proof failed',
                       'python3: bare executable lookup unproved; '):
            for target in (shlex.quote('$d/' + marker + '.mjs'), '"$d/' + marker + '.mjs"'):
                command = 'd=$(mktemp -d)\nnode ' + target
                with self.subTest(filename=target):
                    rule, cause = guard.classify_detail(command, str(self.root))
                    self.assertEqual(rule, UNRESOLVED, cause)
                    self.assertNotIn('instead of bare python3', guard.refusal_reason(rule, cause, str(self.root)))
                    self.adapters(command, rule, expected_reason='same-call heredoc')

    @trusted_node_test
    def test_same_call_inline_node_does_not_run_sibling(self):
        prefix = 'W=$(mktemp -d)\n' + self.heredoc('"$W/prep.py"', 'print(1)')
        prefix += self.heredoc('scripts/a.mjs', 'console.log(1)', append=True)
        for code, expected in [
            ('await import("data:text/javascript,export default 1")', None),
            ('import "data:text/javascript,export default 1"', None),
            ('await import("./scripts/a.mjs")', UNRESOLVED),
            ('import "./scripts/a.mjs"', UNRESOLVED),
            ('await import(process.argv[1])', UNRESOLVED),
        ]:
            for run in ['node --input-type=module -e ' + shlex.quote(code),
                        "node --input-type=module - <<'JS'\n" + code + '\nJS\n']:
                with self.subTest(run=run):
                    self.assertEqual(self.classify(prefix + run), expected)
                    self.adapters(prefix + run, expected)

    def test_same_call_preservation_executable_matrix(self):
        writer = "#!/bin/sh\nprintf 'console.log(2)\\n' > scripts/a.mjs\n"
        commands = {
            'sed': "-i 's/a/b/' config/shards.json", 'python3': "-I -c 'print(1)'",
            'chmod': '+x scripts/a.mjs', 'mkdir': 'other', 'ls': '', 'cat': 'config/shards.json',
            'tee': 'config/shards.json', 'head': 'config/shards.json', 'tail': 'config/shards.json',
            'stat': 'config/shards.json', 'wc': 'config/shards.json', 'cp': 'other config/shards.json',
            'echo': 'ok', 'printf': "'%s' ok", 'true': '', 'false': '', 'pwd': '', 'test': '-f other',
            'set': '', 'unset': 'OTHER', 'print': '-r -- ok', 'cd': '.', 'export': 'OTHER=ok',
            'git': 'show HEAD:config/shards.json', 'linctl': 'issue search probe', 'mktemp': '-d',
            'env': '/usr/bin/true', 'node': "-e 'console.log(1)'", 'bash': '-n config/shards.json',
            'sh': '-n config/shards.json',
        }
        prefix = self.heredoc('scripts/a.mjs', 'console.log(1)')
        for binary, args in commands.items():
            wrapper = self.write('wrappers/' + binary, writer)
            wrapper.chmod(0o755)
            alias = self.root / 'aliases' / binary
            alias.parent.mkdir(exist_ok=True)
            alias.symlink_to(wrapper)
            for label, executable, search in (
                ('relative', './wrappers/' + binary, os.environ['PATH']),
                ('absolute', str(wrapper), os.environ['PATH']),
                ('symlink', str(alias), os.environ['PATH']),
                ('PATH', binary, str(wrapper.parent) + os.pathsep + os.environ['PATH']),
            ):
                if label == 'PATH' and binary in {'echo', 'printf', 'true', 'false', 'pwd', 'test', 'set', 'unset', 'print', 'cd', 'export'}:
                    continue  # A bare shell builtin wins over PATH.
                command = prefix + executable + ' ' + args + '\nnode --test scripts/a.mjs'
                with self.subTest(binary=binary, lookup=label), patch.dict(os.environ, {'PATH': search}):
                    self.assertEqual(self.classify(command), UNRESOLVED)
        for name in ('sed', 'chmod', 'mkdir', 'cat', 'cp', 'python3'):
            executable = '/usr/bin/' + name
            command = self.heredoc(executable, writer) + prefix + executable + ' ' + commands[name]
            command += '\nnode --test scripts/a.mjs'
            with self.subTest(binary=name, lookup='same-call replacement'):
                self.assertEqual(self.classify(command), UNRESOLVED)
        for binary, args in (('env', 'node'), ('offbox', 'run -- node')):
            wrapper = self.write('wrappers/' + binary, writer)
            wrapper.chmod(0o755)
            for inline in (" -e 'console.log(1)'", " --input-type=module - <<'JS'\nconsole.log(1)\nJS\n"):
                command = prefix + str(wrapper) + ' ' + args + inline
                with self.subTest(binary=binary, inline=inline, final_run=False):
                    self.assertEqual(self.classify(command), UNRESOLVED)

    def test_same_call_preservation_startup_matrix(self):
        prefix = self.heredoc('scripts/a.mjs', 'console.log(1)')
        for run in ("sed -i 's/a/b/' config/shards.json", "python3 -I -c 'print(1)'",
                    'chmod +x scripts/a.mjs', 'mkdir other', 'echo ok', "node -e 'console.log(1)'"):
            for name, value in (('BASH_ENV', './startup.sh'), ('ENV', './startup.sh'),
                                ('LD_PRELOAD', './startup.so'), ('DYLD_INSERT_LIBRARIES', './startup.dylib'),
                                ('BASH_FUNC_sed%%', '() { :; }')):
                with self.subTest(run=run, startup=name), patch.dict(os.environ, {name: value}):
                    self.assertEqual(self.classify(prefix + run + '\nnode --test scripts/a.mjs'), UNRESOLVED)
                    if run.startswith('node '):
                        self.assertEqual(self.classify(prefix + run), UNRESOLVED)

    @trusted_node_test
    def test_preservation_review_input_classes(self):
        prefix = self.heredoc('tmp/a.py', 'print(1)')
        final = '\npython3 -I tmp/a.py'
        sed = "sed -i '' " if os.uname().sysname == 'Darwin' else 'sed -i '
        for run in ('tee tmp/a{,.old}.py < /dev/null', 'echo changed > tmp/a{,.old}.py',
                    'cat > tmp/a{,.old}.py <<\'EDIT\'\nprint(2)\nEDIT\n'):
            with self.subTest(expanded_output=run):
                self.assertEqual(self.classify(prefix + run + final), UNRESOLVED)
        for writer in ('cat >', 'tee'):
            for quoted in (False, True):
                target = "'tmp/brace{,.old}.py'" if quoted else 'tmp/brace{,.old}.py'
                run = writer + ' ' + target + " <<'EDIT'\nprint(1)\nEDIT\npython3 -I 'tmp/brace{,.old}.py'"
                with self.subTest(writer=writer, quoted_target=quoted):
                    self.assertEqual(self.classify(run), None if quoted else UNRESOLVED)
        for run in ('exec > tmp/a.py', '> tmp/a.py', 'OTHER=ok > tmp/a.py'):
            with self.subTest(empty_redirect=run):
                self.assertEqual(self.classify(prefix + run + final), UNRESOLVED)
        for expression, target, expected in (
            ("'s/1/2/'", 'tmp/a{,.old}.py', UNRESOLVED),
            ("'s/1/2/'", 'tmp/*.py', UNRESOLVED),
            ('"s/a/$PAYLOAD/"', 'tmp/other.py', UNRESOLVED),
            ("'s/a/$PAYLOAD/'", 'tmp/other.py', None),
            ("'s/1/2/'", "'tmp/a{,.old}.py'", None),
        ):
            with self.subTest(tool='sed', expression=expression, target=target):
                self.assertEqual(self.classify(prefix + sed + expression + ' ' + target + final), expected)
        with patch.object(os, 'uname', return_value=type('Platform', (), {'sysname': 'Darwin'})()):
            run = "sed -i 's/a/b/' 'w tmp/a.py' config/shards.json"
            rule, cause = guard.classify_detail(prefix + run + final, str(self.root))
            self.assertEqual(rule, UNRESOLVED, cause)
            self.assertIn('sed: backup suffix or program unproved', cause)
        with patch.object(os, 'uname', return_value=type('Platform', (), {'sysname': 'Linux'})()):
            self.assertEqual(self.classify(prefix + "sed -i '' 's/1/2/' tmp/other.py" + final), UNRESOLVED)
        for argument in ('', ' harmless', " \"s='$PAYLOAD';print(1)\""):
            for literal in (False, True):
                source = "s='$PAYLOAD';print(1)"
                code = shlex.quote(source) if literal else '"' + source + '"'
                with self.subTest(tool='python', literal=literal, argument=argument):
                    self.assertEqual(self.classify(prefix + 'python3 -I -c ' + code + argument + final),
                                     None if literal else UNRESOLVED)
        for option in ('-X -c', '-W -c', '--check-hash-based-pycs -c', '-Xdev', '-Wignore'):
            with self.subTest(python_option=option):
                self.assertEqual(self.classify(prefix + 'python3 -I ' + option + ' -c "s=\'$PAYLOAD\';print(1)"' + final), UNRESOLVED)
        keywords = ('do', 'then', 'else', '!', 'if', 'while', 'until', 'for', 'done', 'fi')
        for name in ('env', 'command', 'node', 'bash', 'print', 'X=x', *keywords):
            self.write('bin/' + name, '#!/bin/sh\nexit 0\n').chmod(0o755)
        for run in ('./bin/env', './bin/command cd .', './bin/command export OTHER=ok'):
            with self.subTest(wrapper=run):
                self.assertEqual(self.classify(prefix + run + final), UNRESOLVED)
                self.assertEqual(self.classify(prefix + run), UNRESOLVED)
        for wrapper in ('command -p', 'command -pv', 'exec', '/usr/bin/nohup',
                        '/usr/bin/nice -n 1', '/usr/bin/timeout 1', '/usr/bin/sudo -u other',
                        '/usr/bin/env -i', '/usr/bin/env --ignore-environment',
                        '/usr/bin/env -u PATH', '/usr/bin/env -C .'):
            with self.subTest(wrapper_mode=wrapper):
                self.assertEqual(self.classify(prefix + wrapper + ' python3 -I -c \'print(1)\'' + final), UNRESOLVED)
        with patch.dict(os.environ, {'PATH': str(self.root / 'bin') + os.pathsep + os.environ['PATH']}):
            for run in ("command X=x node -e 'console.log(1)'", "'X=x' node -e 'console.log(1)'",
                        'command ./bin/X=x', "sudo --chdir=tmp python3 -I -c 'import json; json.dump({}, open(\"../a.py\",\"w\"))'"):
                with self.subTest(assignment_executable=run):
                    self.assertEqual(self.classify(prefix + run + final), UNRESOLVED)
        for name in keywords:
            for executable in ('./bin/' + name, str(self.root / 'bin' / name), "'" + name + "'", '/usr/bin/env ' + name,
                               "for item in x; do '" + name + "'; done",
                               'command ' + name + " node -e 'console.log(1)'",
                               'command command ' + name + " node -e 'console.log(1)'"):
                with self.subTest(keyword_executable=executable), patch.dict(os.environ, {'PATH': str(self.root / 'bin') + os.pathsep + os.environ['PATH']}):
                    self.assertEqual(self.classify(prefix + executable + final), UNRESOLVED)
        for option in ('-S ', '--split-string ', '--split-string=', '-S'):
            run = '/usr/bin/env ' + option + shlex.quote('print -r -- ok')
            with self.subTest(env_option=option), patch.dict(os.environ, {'PATH': str(self.root / 'bin') + os.pathsep + os.environ['PATH']}):
                self.assertEqual(self.classify(prefix + run + final), UNRESOLVED)
        for option in ('-iSpython3 -I tmp/not-created.py', '-iS', '-viS'):
            with self.subTest(env_cluster=option):
                self.assertEqual(self.classify(prefix + '/usr/bin/env ' + shlex.quote(option) + final), UNRESOLVED)
        for run, target in (('./bin/node --check tmp/a.mjs', 'tmp/a.mjs'),
                            ('./bin/bash -n tmp/check.sh', 'tmp/check.sh')):
            with self.subTest(parse=run):
                self.assertEqual(self.classify(self.heredoc(target, 'echo 1') + run), UNRESOLVED)
        bodies = (
            'const readFileSync = console.log["constructor"]; const trim = readFileSync("process.getBuiltinModule(\'fs\').writeFileSync(\'tmp/a.mjs\',\'console.log(2)\')"); trim();',
            'const trim = console.log.constructor; trim();',
            'const console = JSON; console.log(1);',
        )
        prefix = self.heredoc('tmp/a.mjs', 'console.log(1)')
        for comment in ('# edit {fixture} next\n', '# {a,b} > x\n'):
            with self.subTest(comment=comment):
                self.assertIsNone(self.classify(comment + prefix + 'node tmp/a.mjs'))
        for binary, name, body in (('node', 'a.mjs', 'console.log(1)'),
                                   ('python3 -I', 'a.py', 'print(1)'), ('bash', 'a.sh', 'echo ok')):
            with self.subTest(unproved_writer=binary):
                command = './bin/env\n' + self.heredoc('tmp/' + name, body) + binary + ' tmp/' + name
                self.assertEqual(self.classify(command), UNRESOLVED)
        node = str(Path.home() / '.nvm/versions/node/v0.0.0/bin/node')
        for builtin in ('cd .', 'export OTHER=ok', 'readonly OTHER=ok', 'declare OTHER=ok',
                        'typeset OTHER=ok', 'local OTHER=ok', 'pushd .', 'popd'):
            for target in ('tmp/a.mjs', node):
                redirect = builtin + ' > ' + shlex.quote(target) + '\n'
                command = prefix + redirect if target == 'tmp/a.mjs' else redirect + prefix
                with self.subTest(builtin_redirect=builtin, target=target):
                    self.assertEqual(self.classify(command + "node -e 'console.log(2)'\nnode tmp/a.mjs"), UNRESOLVED)
        fallback = self.heredoc('/usr/bin/node', '#!/bin/sh\nexit 0').replace('cat >', '/bin/cat >')
        with patch.dict(os.environ, {'PATH': str(Path(node).parent)}):
            for wrapper in ('command -p', '/usr/bin/env -i', '/usr/bin/env -u PATH'):
                with self.subTest(default_lookup=wrapper):
                    command = fallback + prefix.replace('cat >', '/bin/cat >') + wrapper + " node -e 'console.log(1)'\nnode tmp/a.mjs"
                    self.assertEqual(self.classify(command), UNRESOLVED)
        for wrapper in ('./bin/env', './bin/command cd .', './bin/command export OTHER=ok'):
            with self.subTest(early_wrapper=wrapper):
                self.assertEqual(self.classify(wrapper + '\n' + prefix + "node -e 'console.log(1)'\nnode tmp/a.mjs"), UNRESOLVED)
        for body in bodies:
            for run in ('node -e ' + shlex.quote(body), "node - <<'JS'\n" + body + '\nJS\n'):
                with self.subTest(node_source=body, mode=run.split()[1]):
                    self.assertEqual(self.classify(prefix + run + '\nnode --test tmp/a.mjs'), UNRESOLVED)

    def test_same_call_retained_execution_requires_startup_proof(self):
        for binary, suffix, body in (('python3', 'py', 'print(1)'), ('node', 'mjs', 'console.log(1)'),
                                     ('bash', 'sh', 'echo ok')):
            wrapper = self.write('bin/' + binary, '#!/bin/sh\nexit 0\n')
            wrapper.chmod(0o755)
            for target, setup in (('tmp/a.' + suffix, ''), ('"$d/a.' + suffix + '"', 'd=$(mktemp -d)\n')):
                prefix = setup + self.heredoc(target, body)
                options = ' -I ' if binary == 'python3' else ' '
                for executable, search in (('./bin/' + binary, os.environ['PATH']),
                                           (str(wrapper), os.environ['PATH']),
                                           (binary, str(wrapper.parent) + os.pathsep + os.environ['PATH'])):
                    with self.subTest(binary=binary, target=target, executable=executable), patch.dict(os.environ, {'PATH': search}):
                        rule, cause = guard.classify_detail(prefix + executable + options + target, str(self.root))
                        self.assertEqual(rule, UNRESOLVED, cause)
                        self.assertIn('executable provenance or mutation proof failed', cause)
                        self.adapters(prefix + executable + options + target, UNRESOLVED)
                for binding in ('export BASH_ENV=./startup.sh\n', 'export PATH\n', 'declare -n OTHER=value\n'):
                    with self.subTest(binary=binary, target=target, binding=binding):
                        rule, cause = guard.classify_detail(prefix + binding + binary + options + target, str(self.root))
                        self.assertEqual(rule, UNRESOLVED, cause)
                        self.assertRegex(cause, 'startup|binding|declaration')
        for runner in ('python3 tmp/a.py', 'python3 -m unittest tmp.a'):
            rule, cause = guard.classify_detail(self.heredoc('tmp/a.py', 'print(1)') + runner, str(self.root))
            self.assertEqual(rule, UNRESOLVED, cause)
            self.assertIn('python: non-isolated startup', cause)
        for target, body, runner in (('tmp/a.py', 'import unittest\nunittest.main()', './bin/python3 -I -m unittest tmp.a'),
                                     ('tmp/a.mjs', 'console.log(1)', 'node --require ./startup.cjs tmp/a.mjs'),
                                     ('tmp/a.mjs', 'console.log(1)', 'node --test-reporter ./startup.mjs --test tmp/a.mjs'),
                                     ('tmp/a.sh', 'echo ok', 'bash --rcfile ./startup.sh -i tmp/a.sh'),
                                     ('tmp/a.py', 'print(1)', './bin/python3 -I -m unknown.module'),
                                     ('tmp/a.py', 'print(1)', "python3 -c 'print(1)'"),
                                     ('tmp/a.py', 'print(1)', "python3 - <<'PY'\nprint(1)\nPY"),
                                     ('tmp/a.sh', 'echo ok', "bash --rcfile ./startup.sh -ic 'echo ok'")):
            with self.subTest(runner=runner):
                rule, cause = guard.classify_detail(self.heredoc(target, body) + runner, str(self.root))
                self.assertEqual(rule, UNRESOLVED, cause)
                self.assertRegex(cause, 'provenance|startup')
        for local in (True, False):
            with self.subTest(node_options_local=local), patch.dict(os.environ, {'NODE_OPTIONS': '' if local else '--require ./startup.cjs'}):
                prefix = self.heredoc('tmp/a.mjs', 'console.log(1)')
                runner = ('NODE_OPTIONS=\'--require ./startup.cjs\' ' if local else '') + 'node tmp/a.mjs'
                rule, cause = guard.classify_detail(prefix + runner, str(self.root))
                self.assertEqual(rule, UNRESOLVED, cause)
                self.assertIn('NODE_OPTIONS startup proof failed', cause)

    def test_same_call_direct_execution_startup(self):
        self.write('bin/env', '#!/bin/sh\nexit 0\n').chmod(0o755)
        for target, setup in (('tmp/a.sh', ''), ('"$d/a.sh"', 'd=$(mktemp -d)\n'),
                              ('tmp/runner', ''), ('"$d/runner"', 'd=$(mktemp -d)\n')):
            for body in ('echo ok', '#!/bin/bash\necho ok', '#!/usr/bin/env bash\necho ok'):
                prefix = setup + self.heredoc(target, body) + 'chmod +x ' + target + '\n'
                run = './' + target if not setup else target
                with self.subTest(target=target, body=body):
                    self.assertIsNone(self.classify(prefix + run))
                for binding in ('BASH_ENV=./startup.sh ', 'ENV=./startup.sh ', './bin/env '):
                    with self.subTest(target=target, body=body, binding=binding):
                        rule, cause = guard.classify_detail(prefix + binding + run, str(self.root))
                        self.assertEqual(rule, UNRESOLVED, cause)
                        self.assertRegex(cause, 'startup|wrapper|assignment')
                        self.adapters(prefix + binding + run, UNRESOLVED)
        for shebang in ('#!/unproved/loader', '#!/usr/bin/env -S bash', '#!/usr/bin/python3',
                        '#!/bin/bash --rcfile=./startup.sh', '#!/usr/bin/bun', '#!/usr/bin/deno',
                        '#!/bin/bash -c', '#!/bin/sh -s', '#!/usr/bin/node --eval', '#!/usr/bin/node -p'):
            command = self.heredoc('tmp/a.sh', shebang + '\necho ok') + 'chmod +x tmp/a.sh\n./tmp/a.sh'
            with self.subTest(shebang=shebang):
                rule, cause = guard.classify_detail(command, str(self.root))
                self.assertEqual(rule, UNRESOLVED, cause)
                self.assertIn('startup', cause)
        for prefix in ('unknown-program\n', self.heredoc('/bin/bash', '#!/bin/sh\nexit 0')):
            command = prefix + self.heredoc('tmp/a.sh', '#!/bin/bash\necho ok') + 'chmod +x tmp/a.sh\n./tmp/a.sh'
            self.assertEqual(self.classify(command), UNRESOLVED)

    @trusted_node_test
    def test_same_call_interpreter_option_boundaries(self):
        for runner in ('bash', 'sh', '/bin/bash'):
            for option in ('-n', '-c', '-s', '-nc'):
                command = self.heredoc('tmp/a.sh', 'cat ' + LIVE) + runner + ' tmp/a.sh ' + option
                with self.subTest(runner=runner, option=option):
                    self.assertEqual(self.classify(command), SCRIPT)
                    self.adapters(command, SCRIPT)
            for target in ('-n', '-c', '-s'):
                command = self.heredoc('./' + target, 'cat ' + LIVE) + runner + ' -- ' + target
                with self.subTest(runner=runner, target=target):
                    self.assertEqual(self.classify(command), SCRIPT)
        command = self.heredoc('./--check', 'require("fs").readFileSync(' + repr(LIVE) + ')') + 'node -- --check'
        self.assertEqual(self.classify(command), SCRIPT)
        self.write('tmp/__init__.py', "open('tmp/a.py', 'w').write('print(2)')")
        for runner in ('python3 -I -m unittest tmp.a', 'python3 -I -m unittest discover -s tmp', 'python3 -I -m tmp.a'):
            command = self.heredoc('tmp/a.py', 'print(1)') + runner
            with self.subTest(runner=runner):
                rule, cause = guard.classify_detail(command, str(self.root))
                self.assertEqual(rule, UNRESOLVED, cause)
                self.assertIn('python: module startup unproved', cause)

    def test_same_call_unproved_runtime_configuration(self):
        for binary in ('bun', 'deno'):
            for option in ('', '-r ./startup.ts', '--require ./startup.ts', '--import ./startup.ts',
                           '--preload ./startup.ts', '--config=./unproved.toml'):
                for target, setup in (('tmp/a.ts', ''), ('"$d/a.ts"', 'd=$(mktemp -d)\n')):
                    command = setup + self.heredoc(target, 'console.log(1)')
                    command += '/usr/bin/' + binary + ' ' + option + ' ' + target
                    with self.subTest(binary=binary, option=option, target=target):
                        rule, cause = guard.classify_detail(command, str(self.root))
                        self.assertEqual(rule, UNRESOLVED, cause)
                        self.assertIn(binary + ': startup configuration unproved', cause)
                        self.adapters(command, UNRESOLVED)
        self.write('bunfig.toml', 'preload = ["./startup.ts"]\n')
        self.write('deno.json', '{"imports": {"x": "./startup.ts"}}')
        for binary in ('bun', 'deno'):
            command = self.heredoc('tmp/a.ts', 'console.log(1)') + '/usr/bin/' + binary + ' tmp/a.ts'
            self.assertEqual(self.classify(command), UNRESOLVED)

    @trusted_node_test
    def test_same_call_read_write_redirects(self):
        target = self.write('tmp/a.py', 'print(1)')
        (self.root / 'alias.py').symlink_to(target)
        for operand in ('tmp/a.py', 'alias.py', 'tmp/*.py', '"$target"'):
            for fd in ('', '0', '1', '3'):
                for runner in ("printf 'print(2)\\n'", 'echo changed', 'cat', 'cd .', 'export OTHER=ok', 'exec', ''):
                    command = 'target=tmp/a.py\n' + self.heredoc('tmp/a.py', 'print(1)')
                    command += runner + ' ' + fd + '<> ' + operand + (' >&3' if fd == '3' else '') + '\npython3 -I tmp/a.py'
                    with self.subTest(operand=operand, fd=fd, runner=runner):
                        self.assertEqual(self.classify(command), UNRESOLVED)
        prefix = self.heredoc('tmp/a.py', 'print(1)')
        for runner in ("printf 'print(2)\\n'", 'cd .', 'export OTHER=ok'):
            self.assertEqual(self.classify(prefix + runner + ' <> tmp/other.py\npython3 -I tmp/a.py'), None)
        node = str(Path.home() / '.nvm/versions/node/v0.0.0/bin/node')
        for runner in ('printf changed', 'cd .', 'export OTHER=ok', 'exec'):
            with self.subTest(replaced_tool=runner):
                command = runner + ' 1<> ' + shlex.quote(node) + '\n'
                command += self.heredoc('tmp/a.mjs', 'console.log(1)') + "node -e 'console.log(1)'\nnode tmp/a.mjs"
                self.assertEqual(self.classify(command), UNRESOLVED)
        self.assertEqual(self.classify('cat <> ' + LIVE), READ)

    @trusted_node_test
    def test_same_call_python_write_requires_isolation(self):
        source = 'import json; json.dump({}, open("config/shards.json", "w"))'
        malicious = "from pathlib import Path\nPath('scripts/a.mjs').write_text('console.log(2)')\ndef dump(*args): pass\n"
        for shape, module in (('file', 'json.py'), ('package', 'json/__init__.py'), ('PYTHONPATH', 'search/json.py')):
            cwd = self.root / shape
            self.write(shape + '/' + module, malicious)
            (cwd / 'config').mkdir()
            for isolated in (False, True):
                for mode in ('eval', 'stdin'):
                    run = 'python3 ' + ('-I ' if isolated else '')
                    run += '-c ' + shlex.quote(source) if mode == 'eval' else "- <<'PY'\n" + source + '\nPY\n'
                    command = self.heredoc('scripts/a.mjs', 'console.log(1)') + run + '\nnode --test scripts/a.mjs'
                    with self.subTest(shape=shape, isolated=isolated, mode=mode), patch.dict(os.environ, {'PYTHONPATH': str(cwd / 'search')}):
                        rule, cause = guard.classify_detail(command, str(cwd))
                        self.assertEqual(rule, None if isolated else UNRESOLVED, cause)
                        if not isolated:
                            self.assertIn('python: non-isolated startup', cause)

    @trusted_node_test
    def test_same_call_python_write_requires_literal_code(self):
        source = "s='$payload'; import json; json.dump({}, open('config/shards.json', 'w'))"
        prefix = self.heredoc('scripts/a.mjs', 'console.log(1)')
        for literal in (True, False):
            argument = shlex.quote(source) if literal else '"' + source + '"'
            command = prefix + 'python3 -I -c ' + argument + '\nnode --test scripts/a.mjs'
            with self.subTest(literal=literal):
                rule, cause = guard.classify_detail(command, str(self.root))
                self.assertEqual(rule, None if literal else UNRESOLVED, cause)
                if not literal:
                    self.assertIn('python: inline source not literal', cause)

    @trusted_node_test
    def test_same_call_inline_node_safe_modes(self):
        prefix = "export OTHER='NODE_OPTIONS+=data'\n" + self.heredoc('scripts/a.mjs', 'console.log(1)')
        prefix += "printf '%s' '-vNODE_OPTIONS'\nprintf -- '-vNODE_OPTIONS'\n"
        prefix += "printf '$opt'\nprintf '*'\nprintf \"\\$opt\"\n"
        prefix += "printf '%s' 'NODE_OPTIONS+=data'\n"
        for options in ('', '--input-type=module ', '--input-type module ',
                        '--input-type=commonjs ', '--input-type commonjs ',
                        '--no-warnings --input-type=module '):
            runs = ['node ' + options + flag + ' ' + shlex.quote(code)
                    for flag in ('-e', '--eval', '-p', '--print')
                    for code in ('console.log(1)', "console.log('$value')", "console.log('*')")]
            runs += ["node " + options + dash + " <<'JS'\nconsole.log(1)\nJS\n" for dash in ('', '-')]
            for run in runs:
                with self.subTest(options=options, run=run):
                    command = prefix + run + '\nnode --test scripts/a.mjs'
                    self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))

    def test_same_call_inline_node_executable_identity(self):
        writer = "#!/bin/sh\nprintf 'console.log(2)\\n' > scripts/a.mjs\n"
        wrapper = self.write('node', writer)
        wrapper.chmod(0o755)
        alias = self.root / 'alias/node'
        alias.parent.mkdir()
        alias.symlink_to(wrapper)
        inherited_path = os.environ['PATH']
        rows = [
            ('relative wrapper', './node', inherited_path),
            ('absolute wrapper', str(wrapper), inherited_path),
            ('PATH wrapper', 'node', str(self.root) + os.pathsep + inherited_path),
            ('relative symlink', './alias/node', inherited_path),
            ('absolute symlink', str(alias), inherited_path),
            ('PATH symlink', 'node', str(alias.parent) + os.pathsep + inherited_path),
            ('relative PATH', 'node', '.' + os.pathsep + inherited_path),
            ('unresolved PATH', 'node', str(self.root / 'missing-bin')),
        ]
        for target, setup in (('scripts/a.mjs', ''), ('"$d/a.mjs"', 'd=$(mktemp -d)\n')):
            prefix = setup + self.heredoc(target, 'console.log(1)')
            for label, executable, search in rows:
                for inline in (" -e 'console.log(1)'\n", " --input-type=module - <<'JS'\nconsole.log(1)\nJS\n"):
                    command = prefix + executable + inline + 'node --test ' + target
                    with self.subTest(target=target, executable=label, inline=inline), patch.dict(os.environ, {'PATH': search}):
                        rule, cause = guard.classify_detail(command, str(self.root))
                        self.assertEqual(rule, UNRESOLVED, cause)
                        self.assertIn('executable provenance or mutation proof failed', cause)
                        self.assertNotIn('console.log(2)', cause)
                        self.adapters(command, UNRESOLVED)
        with self.trusted_node_environment(), patch.dict(os.environ, {'BASH_FUNC_node%%': '() { :; }'}):
            command = self.heredoc('scripts/a.mjs', 'console.log(1)')
            command += "node -e 'console.log(1)'\nnode --test scripts/a.mjs"
            rule, cause = guard.classify_detail(command, str(self.root))
            self.assertEqual(rule, UNRESOLVED, cause)
            self.assertIn('executable provenance or mutation proof failed', cause)
        mktemp = self.write('untrusted-bin/mktemp', writer)
        mktemp.chmod(0o755)
        with self.trusted_node_environment():
            search = str(mktemp.parent) + os.pathsep + os.environ['PATH']
            with patch.dict(os.environ, {'PATH': search}):
                command = 'd=$(mktemp -d)\n' + self.heredoc('scripts/a.mjs', 'console.log(1)')
                command += "node -e 'console.log(1)'\nnode --test scripts/a.mjs"
                rule, cause = guard.classify_detail(command, str(self.root))
                self.assertEqual(rule, UNRESOLVED, cause)
                self.assertIn('executable provenance or mutation proof failed', cause)

    def test_same_call_inline_node_tool_mutations(self):
        home = (self.root / 'home').resolve()
        node = self.write('home/.nvm/versions/node/v26.0.0/bin/node', '#!/bin/sh\nexit 0\n').resolve()
        node.chmod(0o755)
        alias = self.root / 'bin/node'
        alias.parent.mkdir()
        alias.symlink_to(node)
        hardlink = self.root / 'node-hardlink'
        os.link(node, hardlink)
        early = self.root / 'early-bin'
        early.mkdir()
        search = os.pathsep.join((str(early), str(alias.parent), os.environ['PATH']))
        writer = "#!/bin/sh\nprintf 'console.log(2)\\n' > scripts/a.mjs\n"
        edits = {
            'heredoc executable': self.heredoc(str(node), writer),
            'redirect executable': f'cat replacement.sh > {node}\n',
            'append executable': f'cat replacement.sh >> {node}\n',
            'Python executable': "python3 -I -c " + shlex.quote(f'from pathlib import Path; Path({str(node)!r}).write_text({writer!r})') + '\n',
            'copy executable': f'cp replacement.sh {node}\n',
            'move executable': f'mv replacement.sh {node}\n',
            'sed executable': f'sed -i s/exit/echo/ {node}\n',
            'replace executable directory': f'mv replacement-bin {node.parent}\n',
            'replace symlink': f'ln -sf replacement.sh {alias}\n',
            'write symlink target': self.heredoc(str(alias), writer),
            'write hardlink': self.heredoc(str(hardlink), writer),
            'change PATH': f'PATH={self.root}:$PATH\n',
            'unset PATH': 'unset PATH\n',
        }
        for template in ('', ' invalid', ' /missing/probe.XXXXXX', ' -t probe.XXXXXX'):
            setup = 'd=$(mktemp -d' + template + ')\n'
            target = '"$d' + str(node) + '"'
            edits['fresh-root heredoc fallback' + template] = setup + self.heredoc(target, writer)
            edits['fresh-root copy fallback' + template] = setup + 'cp replacement.sh ' + target + '\n'
        with patch.object(Path, 'home', return_value=home), patch.dict(os.environ, {'PATH': search}):
            for executable in ('node', str(node), str(alias)):
                for inline in (" -e 'console.log(1)'\n", " --input-type=module - <<'JS'\nconsole.log(1)\nJS\n"):
                    prefix = self.heredoc('scripts/a.mjs', 'console.log(1)')
                    run = executable + inline + 'node --test scripts/a.mjs'
                    with self.subTest(executable=executable, inline=inline):
                        self.assertEqual(guard.classify_detail(prefix + run, str(self.root)), (None, None))
                    for label, edit in edits.items():
                        for before in (True, False):
                            command = (edit + prefix if before else prefix + edit) + run
                            with self.subTest(executable=executable, inline=inline, mutation=label, before=before):
                                rule, cause = guard.classify_detail(command, str(self.root))
                                self.assertEqual(rule, UNRESOLVED, cause)
                                self.adapters(command, UNRESOLVED)
                                if before and label not in {'change PATH', 'unset PATH'}:
                                    self.assertIn('executable provenance or mutation proof failed', cause)
            for inline in (" -e 'console.log(1)'\n", " --input-type=module - <<'JS'\nconsole.log(1)\nJS\n"):
                for spelling in ('node', 'Node', 'NODE'):
                    edit = self.heredoc(str(early / spelling), writer) + 'chmod +x ' + str(early / spelling) + '\n'
                    for before in (True, False):
                        command = (edit + prefix if before else prefix + edit) + 'node' + inline + 'node --test scripts/a.mjs'
                        with self.subTest(mutation='shadow earlier PATH entry', spelling=spelling, before=before, inline=inline):
                            rule, cause = guard.classify_detail(command, str(self.root))
                            self.assertEqual(rule, UNRESOLVED, cause)
                            self.assertIn('node: executable provenance or mutation proof failed', cause)

    def test_same_call_inline_node_tool_path_normalization(self):
        home = (self.root / 'home').resolve()
        node = self.write('home/.nvm/versions/node/v26.0.0/bin/node', '#!/bin/sh\nexit 0\n').resolve()
        node.chmod(0o755)
        early = self.root / 'early-é'
        early.mkdir()
        search = str(early) + os.pathsep + str(node.parent) + os.pathsep + os.environ['PATH']
        for spelling in ('early-é/Node', 'EARLY-É/node', 'early-e\u0301/node', 'EARLY-E\u0301/NODE'):
            edit = self.heredoc(str(self.root / spelling), '#!/bin/sh\nexit 0\n')
            edit += 'chmod +x ' + str(self.root / spelling) + '\n'
            prefix = self.heredoc('scripts/a.mjs', 'console.log(1)')
            command = edit + prefix + "node -e 'console.log(1)'\nnode --test scripts/a.mjs"
            with self.subTest(spelling=spelling), patch.object(Path, 'home', return_value=home), patch.dict(os.environ, {'PATH': search}):
                rule, cause = guard.classify_detail(command, str(self.root))
                self.assertEqual(rule, UNRESOLVED, cause)
                self.assertIn('node: executable provenance or mutation proof failed', cause)

    @trusted_node_test
    def test_same_call_inline_node_runtime_options(self):
        self.write('scripts/mutate.cjs', "require('node:fs').writeFileSync('scripts/a.mjs', 'console.log(2)')")
        self.write('package.json', json.dumps({'scripts': {'mutate': 'node scripts/mutate.cjs'}}))
        # Runtime mode, startup inputs, output side effects and unknown flags
        # must all fail closed, including options following an eval body.
        options = (
            '--run mutate', '--run=mutate', '--require ./scripts/mutate.cjs', '--require=./scripts/mutate.cjs',
            '-r ./scripts/mutate.cjs', '-r./scripts/mutate.cjs', '--import ./scripts/mutate.cjs',
            '--loader ./scripts/mutate.cjs', '--experimental-loader ./scripts/mutate.cjs',
            '--test-global-setup ./scripts/mutate.cjs', '--env-file ./node.env', '--env-file-if-exists=./node.env',
            '--experimental-config-file ./node.json', '--snapshot-blob ./node.blob',
            '--redirect-warnings scripts/a.mjs', '--cpu-prof', '--heap-prof', '--trace-events-enabled',
            '--test', '--watch', '--unknown-guard-option', '--input-type=unknown',
        )
        for target, setup in (('scripts/a.mjs', ''), ('"$d/a.mjs"', 'd=$(mktemp -d)\n')):
            prefix = setup + self.heredoc(target, 'console.log(1)')
            for option in options:
                for run in (f"node {option} -e 'console.log(1)'",
                            f"node -e 'console.log(1)' {option}",
                            f"node {option} - <<'JS'\nconsole.log(1)\nJS\n"):
                    with self.subTest(target=target, option=option, run=run):
                        command = prefix + run + '\nnode --test ' + target
                        rule, cause = guard.classify_detail(command, str(self.root))
                        self.assertEqual(rule, UNRESOLVED)
                        self.assertIn('node: inline runtime options or arguments unproved', cause)
                        self.assertNotIn('mutate', cause)
        self.adapters(self.heredoc('scripts/a.mjs', 'console.log(1)') +
                      "node --run mutate -e 'console.log(1)'\nnode --test scripts/a.mjs", UNRESOLVED)
        code = "console.log('$value')"
        command = self.heredoc('scripts/a.mjs', 'console.log(1)')
        command += 'env OTHER=' + shlex.quote(code) + ' node -e "' + code + '"\nnode --test scripts/a.mjs'
        rule, cause = guard.classify_detail(command, str(self.root))
        self.assertEqual(rule, UNRESOLVED)
        self.assertIn('node: inline source not literal', cause)

    def test_same_call_inline_node_startup_environment(self):
        self.write('preload.cjs', "require('node:fs').writeFileSync('scripts/a.mjs', 'console.log(2)')")
        self.write('-v', '')
        setting = shlex.quote('--require ./preload.cjs')
        for target, setup in (('scripts/a.mjs', ''), ('"$d/a.mjs"', 'd=$(mktemp -d)\n')):
            prefix = setup + self.heredoc(target, 'console.log(1)')
            for run in ("node --input-type=module -e 'console.log(1)'",
                        "node --input-type=module - <<'JS'\nconsole.log(1)\nJS\n"):
                tail = '\nnode --test ' + target
                for placement, command, inherited in (
                    ('command-local', prefix + 'NODE_OPTIONS=' + setting + ' ' + run + tail, ''),
                    ('env', prefix + 'env NODE_OPTIONS=' + setting + ' ' + run + tail, ''),
                    ('assignment', 'NODE_OPTIONS=' + setting + '\n' + prefix + run + tail, ''),
                    ('export', 'export NODE_OPTIONS=' + setting + '\n' + prefix + run + tail, ''),
                    ('append', 'NODE_OPTIONS+=' + setting + '\n' + prefix + run + tail, ''),
                    ('export-append', 'export NODE_OPTIONS+=' + setting + '\n' + prefix + run + tail, ''),
                    ('readonly-append', 'readonly NODE_OPTIONS+=' + setting + '\n' + prefix + run + tail, ''),
                    ('declare-append', 'declare -x NODE_OPTIONS+=' + setting + '\n' + prefix + run + tail, ''),
                    ('typeset-append', 'typeset -x NODE_OPTIONS+=' + setting + '\n' + prefix + run + tail, ''),
                    ('array-assignment', 'NODE_OPTIONS[0]=' + setting + '\n' + prefix + run + tail, ''),
                    ('computed-declaration', 'binding=NODE_OPTIONS\nexport "$binding"=' + setting + '\n' + prefix + run + tail, ''),
                    ('declaration-brace-prefix', 'export {NODE_OPTIONS,OTHER}=' + setting + '\n' + prefix + run + tail, ''),
                    ('declaration-brace-suffix', 'export NODE_{OPTIONS,OTHER}=' + setting + '\n' + prefix + run + tail, ''),
                    ('declaration-brace-infix', 'export NODE_OP{TION,TIO}S=' + setting + '\n' + prefix + run + tail, ''),
                    ('declaration-brace-nested', 'export NODE_{OPTION{S,X},OTHER}=' + setting + '\n' + prefix + run + tail, ''),
                    ('declaration-brace-quoted-prefix', "export 'NODE_'{OPTIONS,OTHER}=" + setting + '\n' + prefix + run + tail, ''),
                    ('declaration-brace-declare', 'declare -x NODE_{OPTIONS,OTHER}=' + setting + '\n' + prefix + run + tail, ''),
                    ('declaration-brace-typeset', 'typeset -x NODE_{OPTIONS,OTHER}=' + setting + '\n' + prefix + run + tail, ''),
                    ('declaration-brace-readonly', 'readonly NODE_{OPTIONS,OTHER}=' + setting + '\n' + prefix + run + tail, ''),
                    ('declaration-brace-then-unset', 'export NODE_{OPTIONS,OTHER}=' + setting + '\n' + prefix + run + '\nunset NODE_OPTIONS' + tail, ''),
                    ('read', "read -r NODE_OPTIONS <<'OPTS'\n--require ./preload.cjs\nOPTS\n" + prefix + run + tail, ''),
                    ('printf', "printf -v NODE_OPTIONS '%s' " + setting + '\n' + prefix + run + tail, ''),
                    ('printf-attached', "set -a; printf -vNODE_OPTIONS '%s' " + setting + '\n' + prefix + run + tail, ''),
                    ('printf-attached-computed', "binding=NODE_OPTIONS; printf -v\"$binding\" '%s' " + setting + '\n' + prefix + run + tail, ''),
                    ('command-printf-attached', "command printf -vNODE_OPTIONS '%s' " + setting + '\n' + prefix + run + tail, ''),
                    ('printf-expanded', "set -a; opt=-v; printf \"$opt\" NODE_OPTIONS '%s' " + setting + '\n' + prefix + run + tail, ''),
                    ('printf-expanded-unquoted', "opt=-v; printf $opt NODE_OPTIONS '%s' " + setting + '\n' + prefix + run + tail, ''),
                    ('printf-expanded-braces', "opt=-v; printf ${opt} NODE_OPTIONS '%s' " + setting + '\n' + prefix + run + tail, ''),
                    ('printf-empty-expansion', "opt=; printf $opt -v NODE_OPTIONS '%s' " + setting + '\n' + prefix + run + tail, ''),
                    ('printf-mixed-quotes', "opt=-v; printf \"$opt\" NODE_OPTIONS '%.0s%s' '$opt' " + setting + '\n' + prefix + run + tail, ''),
                    ('printf-substitution', "printf $(echo -v) NODE_OPTIONS '%s' " + setting + '\n' + prefix + run + tail, ''),
                    ('printf-backticks', "printf `echo -v` NODE_OPTIONS '%s' " + setting + '\n' + prefix + run + tail, ''),
                    ('printf-glob', "printf -? NODE_OPTIONS '%s' " + setting + '\n' + prefix + run + tail, ''),
                    ('printf-braces', "printf {-v,NODE_OPTIONS} '%s' " + setting + '\n' + prefix + run + tail, ''),
                    ('wait', 'wait -p NODE_OPTIONS\n' + prefix + run + tail, ''),
                    ('wait-attached', 'wait -pNODE_OPTIONS\n' + prefix + run + tail, ''),
                    ('wait-combined', 'wait -npNODE_OPTIONS\n' + prefix + run + tail, ''),
                    ('wait-expanded', 'opt=-pNODE_OPTIONS; wait "$opt"\n' + prefix + run + tail, ''),
                    ('loop', prefix + 'for NODE_OPTIONS in ' + setting + '; do\n' + run + '\ndone' + tail, ''),
                    ('inherited', prefix + run + tail, '--require ./preload.cjs'),
                    ('inherited-after-transient-empty', 'NODE_OPTIONS= true\n' + prefix + run + tail, '--require ./preload.cjs'),
                    ('offbox-env', 'NODE_OPTIONS=' + setting + ' offbox run -- bash -c ' + shlex.quote(prefix + run + tail), ''),
                ):
                    with self.subTest(target=target, run=run, placement=placement), patch.dict(os.environ, {'NODE_OPTIONS': inherited}):
                        rule, cause = guard.classify_detail(command, str(self.root))
                        self.assertEqual(rule, UNRESOLVED)
                        self.assertRegex(cause, r'NODE_OPTIONS startup proof failed|shell lookup or startup proof failed|executable provenance or mutation proof failed|binding|declaration|wrapper|brace expansion')
                        self.assertNotIn('preload.cjs', cause)
                        self.adapters(command, UNRESOLVED)

    @trusted_node_test
    def test_same_call_single_quoted_binding_punctuation(self):
        code = 's="(( ${t.name}"; print(s)'
        prefix = 'd=$(mktemp -d)\npython3 -I -c ' + shlex.quote(code) + '\n'
        command = prefix + self.heredoc('"$d/x.mjs"', 'console.log(1)')
        command += 'node --test --test-name-pattern foo "$d/x.mjs"'
        self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))
        self.adapters(command)
        writer = 'import sys; open(sys.argv[1], "w").write("(( ${t.name}")'
        command = 'd=$(mktemp -d)\npython3 -I -c ' + shlex.quote(writer) + ' "$d/x.mjs"\nnode --test "$d/x.mjs"'
        rule, cause = guard.classify_detail(command, str(self.root))
        self.assertEqual(rule, UNRESOLVED)
        self.assertIn('no readable same-call heredoc writer', cause)

    def test_same_call_binding_causes(self):
        rows = {
            '((i++))': '(( arithmetic',
            'f(){ :; }': 'function definition',
            'function f { :; }': 'function definition',
            'echo "${d:-/tmp}"': 'non-simple ${} expansion',
            "echo $'(( ${x:-y}'": '(( arithmetic',
            'echo `echo "${x:-y}"`': 'non-simple ${} expansion',
            'PATH=/bin': 'PATH assignment',
            'IFS=,': 'IFS assignment',
            "trap ':' EXIT": 'shell binding builtin',
            'declare -n other=d': 'non-scalar declaration',
            'export PATH': 'startup binding declaration',
            'unset PATH': 'PATH unset',
        }
        for binding, expected in rows.items():
            command = 'd=$(mktemp -d)\n' + binding + '\n'
            command += self.heredoc('"$d/x.mjs"', 'console.log(1)') + 'node "$d/x.mjs"'
            with self.subTest(binding=binding):
                rule, cause = guard.classify_detail(command, str(self.root))
                self.assertEqual(rule, UNRESOLVED)
                self.assertIn(expected, cause)
                self.assertRegex(cause, r'at line \d+')

    def test_same_call_startup_append_and_printf_bindings(self):
        writer = self.heredoc('"$d/x.sh"', '#!/bin/bash\necho ok')
        names = ('PATH', 'IFS', 'BASH_ENV', 'ENV', 'BASHOPTS', 'SHELLOPTS', 'ZDOTDIR', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'CDPATH')
        rows = [(f'{declaration} {name}+=startup.sh', False)
                for declaration in ('export', 'readonly', 'declare', 'typeset', 'local') for name in names]
        rows += [(f'{name}+=startup.sh', False) for name in names]
        rows += [(command, safe) for command, safe in (
            ("printf '%n' PATH", False), ("printf '%10n' BASH_ENV", False),
            ("printf '%.*n' 2 ENV", False), ('printf "$FORMAT" PATH', False),
            ("printf -vPATH '%s' /unproved", False), ("printf -- '%n' PATH", False),
            ("printf '%%n' PATH", True), ("printf '%%%n' PATH", False),
            ("printf '%s\\n' ok", True), ("printf -- '%s' ok", True),
        )]
        for binding, safe in rows:
            for before in (False, True):
                command = 'd=$(mktemp -d)\n' + (binding + '\n' + writer if before else writer + binding + '\n')
                command += 'bash "$d/x.sh"'
                with self.subTest(binding=binding, before=before):
                    rule, cause = guard.classify_detail(command, str(self.root))
                    self.assertEqual(rule, None if safe else UNRESOLVED, cause)
                    if not safe:
                        self.assertRegex(cause, r'at line \d+')

    def test_same_call_startup_input_boundaries(self):
        for root, execution in (('tmp/a.sh', './tmp/a.sh'), ('"$d/a.sh"', '"$d/a.sh"')):
            for shebang in ("#!/usr/bin/env 'bash'", '#!/usr/bin/env "bash"', '#!/usr/bin/env ba\\sh',
                            '#!/usr/bin/env bash\r', '#!/bin/ba\\sh', '#!/bin/"bash"'):
                command = 'd=$(mktemp -d)\n' + self.heredoc(root, shebang + '\necho ok')
                with self.subTest(shebang=shebang, root=root):
                    rule, cause = guard.classify_detail(command + execution, str(self.root))
                    self.assertEqual(rule, UNRESOLVED, cause)
                    self.assertIn('shebang word unproved', cause)
        for options in ('+n', '+s', '+e', '-n +n', '-e +n', '+o noclobber'):
            for retained in (False, True):
                for body in ('echo ok', 'cat ' + LIVE):
                    prefix = self.heredoc('tmp/a.sh', body) if retained else ''
                    self.write('tmp/a.sh', body)
                    with self.subTest(options=options, retained=retained, body=body):
                        rule, cause = guard.classify_detail(prefix + 'bash ' + options + ' tmp/a.sh', str(self.root))
                        self.assertEqual(rule, UNRESOLVED, cause)
                        self.assertIn('plus options unproved', cause)
        writer = self.heredoc('tmp/a.py', 'print(1)')
        for name in ('PATH', 'IFS', 'BASH_ENV', 'ENV', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'CDPATH', 'NODE_OPTIONS'):
            for loop in ('for', 'select'):
                command = writer + f'{loop} {name} in /scratch/shadow; do python3 -I tmp/a.py; done'
                with self.subTest(name=name, loop=loop):
                    rule, cause = guard.classify_detail(command, str(self.root))
                    self.assertEqual(rule, UNRESOLVED, cause)
                    self.assertRegex(cause, 'startup proof failed|loop startup binding')

    def test_same_call_clobber_redirects(self):
        self.write('tmp/clobber.py', 'print(1)')
        (self.root / 'alias.py').symlink_to(self.root / 'tmp/clobber.py')
        os.link(self.root / 'tmp/clobber.py', self.root / 'hardlink.py')
        for operator in ('>!', '>>!', '1>!', '2>>!', '>|', '>>|', '&>!', '&>>!'):
            for target in ('tmp/clobber.py', 'alias.py', 'hardlink.py', '"$d/clobber.py"'):
                retained = '"$d/clobber.py"' if '$d' in target else 'tmp/clobber.py'
                prefix = 'd=$(mktemp -d)\n' + self.heredoc(retained, 'print(1)')
                command = prefix + "printf '%s' 'print(2)' " + operator + ' ' + target + '\npython3 -I ' + retained
                with self.subTest(operator=operator, target=target):
                    rule, cause = guard.classify_detail(command, str(self.root))
                    self.assertEqual(rule, UNRESOLVED, cause)
                    self.assertRegex(cause, r'clobber redirect unproved at line \d+')
        source = self.heredoc('tmp/clobber.py', 'print(1)')
        self.assertEqual(guard.classify_detail(source + "# >! comment\nprintf '%s' '>! >>| literal'\npython3 -I tmp/clobber.py",
                                              str(self.root)), (None, None))

    def test_same_call_zsh_special_bindings(self):
        writer = self.heredoc('tmp/safe.py', 'print(1)')
        names = ('path', 'cdpath', 'fpath', 'FPATH', 'ARGV0', 'NULLCMD', 'READNULLCMD',
                 'commands', 'functions', 'aliases', 'options')
        for name in names:
            for binding in (f'{name}=/scratch/shadow', f'export {name}+=startup',
                            f'typeset {name}=/scratch/shadow', f'for {name} in /scratch/shadow; do :; done'):
                for before in (False, True):
                    command = (binding + '\n' + writer if before else writer + binding + '\n') + 'python3 -I tmp/safe.py'
                    with self.subTest(binding=binding, before=before):
                        rule, cause = guard.classify_detail(command, str(self.root))
                        self.assertEqual(rule, UNRESOLVED, cause)
                        self.assertRegex(cause, r'at line \d+')
        for binding in ('commands[python3]=./rewrite', 'functions[python3]=rewrite',
                        'ARGV0=-bash /bin/bash tmp/safe.sh', 'NULLCMD=./rewrite; > sibling.txt',
                        'READNULLCMD=./rewrite; < sibling.txt'):
            self.assertEqual(self.classify(writer + binding + '\npython3 -I tmp/safe.py'), UNRESOLVED, binding)
        for name in ('ARGV0', 'NULLCMD', 'READNULLCMD'):
            with patch.dict(os.environ, {name: './rewrite'}), self.subTest(inherited=name):
                self.assertEqual(self.classify(writer + 'python3 -I tmp/safe.py'), UNRESOLVED)

    def test_same_call_shell_startup_and_bare_dash(self):
        home = self.root / 'zsh-home'
        home.mkdir()
        (home / '.zshenv').write_text("printf '%s' changed > tmp/safe.sh\n")
        with patch.dict(os.environ, {'HOME': str(home), 'ZDOTDIR': ''}):
            for target, execution in (('tmp/safe.sh', 'zsh tmp/safe.sh'),
                                      ('tmp/safe.sh', './tmp/safe.sh'),
                                      ('"$d/safe.sh"', '"$d/safe.sh"')):
                command = 'd=$(mktemp -d)\n' + self.heredoc(target, '#!/bin/zsh\necho ok') + execution
                with self.subTest(execution=execution):
                    rule, cause = guard.classify_detail(command, str(self.root))
                    self.assertEqual(rule, UNRESOLVED, cause)
                    self.assertIn('implicit startup unproved', cause)
        for binary in ('bash', 'sh', '/bin/bash', '/bin/sh'):
            for option in ('-', '-e -', '-n -', '-- -'):
                for retained in (False, True):
                    for body in ('echo ok', 'cat ' + LIVE):
                        self.write('tmp/safe.sh', body)
                        prefix = self.heredoc('tmp/safe.sh', body) if retained else ''
                        with self.subTest(binary=binary, option=option, retained=retained, body=body):
                            rule, cause = guard.classify_detail(prefix + binary + ' ' + option + ' tmp/safe.sh', str(self.root))
                            self.assertEqual(rule, UNRESOLVED, cause)
                            self.assertIn('bare dash input unproved', cause)

    def test_same_call_continued_redirects_and_loop_targets(self):
        self.write('tmp/a.py', 'print(1)')
        (self.root / 'continued-alias.py').symlink_to(self.root / 'tmp/a.py')
        os.link(self.root / 'tmp/a.py', self.root / 'continued-hard.py')
        for operator in ('>\\\n!', '>>\\\n!', '>\\\n|', '>\\\n>', '> \\\n!', '\\\n>!', '>\\\n\\\n!'):
            for target in ('tmp/a.py', 'continued-alias.py', 'continued-hard.py', '"$d/a.py"'):
                retained = '"$d/a.py"' if '$d' in target else 'tmp/a.py'
                command = 'd=$(mktemp -d)\n' + self.heredoc(retained, 'print(1)')
                command += "printf '%s' 'print(2)' " + operator + ' ' + target + '\npython3 -I ' + retained
                with self.subTest(operator=operator, target=target):
                    rule, cause = guard.classify_detail(command, str(self.root))
                    self.assertEqual(rule, UNRESOLVED, cause)
                    self.assertIn('continued redirect unproved', cause)
        for targets in ('item PATH', 'PATH item', 'item other PATH', 'item OTHER', 'item NULLCMD', 'item PS4'):
            for loop in ('for', 'select'):
                command = self.heredoc('tmp/a.py', 'print(1)')
                command += f'{loop} {targets} in ok /scratch/shadow; do python3 -I tmp/a.py; done'
                with self.subTest(targets=targets, loop=loop):
                    rule, cause = guard.classify_detail(command, str(self.root))
                    self.assertEqual(rule, UNRESOLVED, cause)
                    self.assertIn('loop targets unproved', cause)

    def test_same_call_parse_only_requires_complete_startup(self):
        self.write('tmp/a.sh', 'echo ok')
        for options in ('-ni', '-in', '-n -i', '-i -n', '--noprofile --norc -ni'):
            for operand in ('tmp/a.sh', "-c 'echo safe_marker'"):
                for retained in (False, True):
                    prefix = self.heredoc('tmp/a.sh', 'echo ok') if retained else ''
                    with self.subTest(options=options, operand=operand, retained=retained):
                        rule, cause = guard.classify_detail(prefix + '/bin/bash ' + options + ' ' + operand, str(self.root))
                        self.assertEqual(rule, UNRESOLVED, cause)
                        self.assertIn('startup options unproved', cause)

    def test_same_call_executable_trace_bindings(self):
        writer = self.heredoc('tmp/a.py', 'print(1)')
        for name in ('PS4', 'PROMPT4', 'BASH_XTRACEFD'):
            for binding in (f"{name}='$(printf print2 > tmp/a.py)'", f'export {name}+=unproved',
                            f'for {name} in unproved; do :; done'):
                for enable in ('set -x', 'set -o xtrace'):
                    batch = writer + binding + '\n' + enable + '\npython3 -I tmp/a.py'
                    for command in (batch, '/bin/bash -c ' + shlex.quote(batch)):
                        with self.subTest(name=name, binding=binding, enable=enable, wrapped=command != batch):
                            rule, cause = guard.classify_detail(command, str(self.root))
                            self.assertEqual(rule, UNRESOLVED, cause)
                            self.assertRegex(cause, r'at line \d+')
        with patch.dict(os.environ, {'PS4': '$(unproved)'}):
            self.assertEqual(self.classify(writer + 'set -x\npython3 -I tmp/a.py'), UNRESOLVED)

    def test_same_call_preflight_physical_lines(self):
        for quoted in ("'line_one\nline_two\nline_three'", '"line_one\nline_two\nline_three"',
                       '"line_one$(printf \'line_two\nline_three\')\nline_four"'):
            for suffix, reason in (("printf x >\\\n! tmp/a.py", 'continued redirect'),
                                   ('printf x >! tmp/a.py', 'clobber redirect'),
                                   ('printf x > tmp/a{,.old}.py', 'shell brace expansion or word boundary')):
                command = self.heredoc('tmp/a.py', 'print(1)') + 'echo ' + quoted + '\n'
                command += suffix + '\npython3 -I tmp/a.py'
                with self.subTest(quoted=quoted, reason=reason):
                    rule, cause = guard.classify_detail(command, str(self.root))
                    self.assertEqual(rule, UNRESOLVED, cause)
                    self.assertEqual(cause, reason + ' unproved at line 7')

    def test_same_call_python_environment_writer_reason(self):
        command = '''TASK_DIR=$(mktemp -d)
export TASK_DIR
python3 -I - <<'PYBODY'
from pathlib import Path
import os
(Path(os.environ['TASK_DIR'])/'step5r.sh').write_text('echo WRITER_CONTENT_PRIVATE')
PYBODY
bash "$TASK_DIR/step5r.sh"
'''
        rule, cause = guard.classify_detail(command, str(self.root))
        self.assertEqual(rule, UNRESOLVED)
        self.assertIn('python: write target not literal', cause)
        self.assertNotIn('WRITER_CONTENT_PRIVATE', cause)
        reason = guard.refusal_reason(rule, cause, str(self.root))
        expected = ("Could not check '$TASK_DIR/step5r.sh': a python3 command may have written it (line 3), "
                    'and the guard can only inspect scripts written by a same-call heredoc.')
        self.assertIn(expected, reason)
        self.assertIn('\nAccepted: d=$(mktemp -d); cat > ', reason)
        self.adapters(command, UNRESOLVED, expected_reason=expected)

    def test_same_call_inherited_startup_mutation_history(self):
        home, helper, environment = self.repo_node_pin()
        alias = self.root / 'startup-alias'
        hardlink = self.root / 'startup-hardlink'
        alias.symlink_to(helper / 'bash-env.sh')
        os.link(helper / 'init.sh', hardlink)
        package = self.write('package.json', '{}')
        (self.root / 'package-alias').symlink_to(package)
        (self.root / 'selector-alias').symlink_to(helper / 'select.py')
        source = self.heredoc('tmp/a.sh', '#!/bin/bash\necho ok')
        rows = ["printf '%s' changed > startup-alias", "printf '%s' changed > startup-hardlink",
                "printf '%s' changed > selector-alias", "printf '%s' changed > package-alias",
                'cp replacement ' + shlex.quote(str(helper)), 'opaque-mutator']
        for mutation in rows:
            for execution in ('bash tmp/a.sh', './tmp/a.sh'):
                with patch.dict(os.environ, environment), self.subTest(mutation=mutation, execution=execution):
                    rule, cause = guard.classify_detail(source + mutation + '\n' + execution, str(self.root))
                    self.assertEqual(rule, UNRESOLVED, cause)
                    if mutation == 'opaque-mutator':
                        self.assertIn('executable provenance or mutation proof failed', cause)
                    else:
                        self.assertIn('may be changed by this command', cause)
                        self.assertIn(str(package) if 'package-alias' in mutation else str(helper), cause)
        with patch.dict(os.environ, environment):
            for execution in ('bash tmp/a.sh', './tmp/a.sh'):
                self.assertEqual(guard.classify_detail(source + "printf '%s' ok > sibling.txt\n" + execution,
                                                      str(self.root)), (None, None))

    def test_same_call_nonwriters_and_sed_sibling(self):
        suffix = " ''" if os.uname().sysname == 'Darwin' else ''
        for command in ['chmod +x "$d/x.sh"', 'chmod -R u+x "$d"', 'mkdir "$d/other"', 'ls', 'cat config/shards.json',
                        'test -f "$d/x.sh"', 'echo hello', "sed -i" + suffix + " 's/a/b/' config/shards.json"]:
            prefix = 'd=$(mktemp -d)\n' + self.heredoc('"$d/x.sh"', 'echo ok')
            with self.subTest(command=command):
                self.assertEqual(guard.classify_detail(prefix + command + '\nbash "$d/x.sh"', str(self.root)), (None, None))
        command = 'd=$(mktemp -d)\n' + self.heredoc('"$d/x.sh"', 'echo ok')
        self.assertEqual(self.classify(command + 'chmod +x "$d/x.sh"\n"$d/x.sh"'), None)

    def test_same_call_mutation_causes_and_aliases(self):
        self.write('scripts/a.mjs', 'console.log(1)')
        (self.root / 'alias.mjs').symlink_to(self.root / 'scripts/a.mjs')
        os.link(self.root / 'scripts/a.mjs', self.root / 'hardlink.mjs')
        rows = [
            "python3 -I -c \"open('scripts/a.mjs','w').write('SECRET_BODY')\"",
            "python3 -I -c \"open('scripts/' + input(), 'w').write('SECRET_BODY')\"",
            "python3 -I -c \"import glob; [open(p,'w').write('SECRET_BODY') for p in glob.glob('scripts/*')]\"",
            "python3 -I -c \"from pathlib import Path; Path('alias.mjs').write_text('SECRET_BODY')\"",
            "python3 -I -c \"from pathlib import Path; Path('hardlink.mjs').write_text('SECRET_BODY')\"",
            "sed -i 's/a/SECRET_BODY/' scripts/a.mjs", 'cp other.mjs scripts/a.mjs',
            'mv other scripts', 'rsync -a other/ scripts/', 'git restore scripts/a.mjs',
            'git checkout -- scripts/a.mjs', 'git stash pop',
        ]
        for edit in rows:
            command = self.heredoc('scripts/a.mjs', 'console.log(1)') + edit + '\nnode --test scripts/a.mjs'
            with self.subTest(edit=edit):
                rule, cause = guard.classify_detail(command, str(self.root))
                self.assertEqual(rule, UNRESOLVED)
                self.assertIn('at line', cause)
                self.assertIn('execution interpreter operand: node', cause)
                self.assertNotIn('SECRET_BODY', cause)
                self.assertNotIn(edit, cause)

    def test_same_call_audit_retains_proof_sites_without_command_text(self):
        target = 'scripts/' + 'a' * 120 + '.mjs'
        command = self.heredoc(target, 'console.log(1)') + 'SECRET_BINARY SECRET_BODY\nnode --test ' + target
        state = self.root / 'audit'
        for harness, tool, field in [('claude', 'Bash', 'command'), ('codex', 'exec_command', 'cmd')]:
            event = {'hook_event_name': 'PreToolUse', 'cwd': str(self.root), 'tool_name': tool,
                     'tool_input': {field: command}}
            with self.subTest(harness=harness), patch.dict(os.environ, {'HARNESS_HOOKS_STATE_DIR': str(state)}), \
                    patch.object(engine, '_command_identity_key', return_value=b'fixture-key'), patch.object(engine, '_tool_log'):
                self.assertEqual(engine.decide(event, harness)['decision'], 'deny')
                row = json.loads((state / 'decisions.jsonl').read_text().splitlines()[-1])
                self.assertIn('intervening command: opaque binary', row['cause'])
                self.assertIn('execution interpreter operand: node', row['cause'])
                self.assertNotIn('SECRET', json.dumps(row))
                self.assertIsNone(row['cmd'])

    def test_same_call_additional_write_proof_negatives(self):
        prefix = self.heredoc('scripts/a.mjs', 'console.log(1)')
        edits = [
            "python3 -I -c \"import json; json.dump({}, open('scripts/a.mjs', 'w'))\"",
            "python3 -I -c \"import json; from pathlib import Path; json.dump({}, open('config/x', 'w'), default=Path('scripts/a.mjs').touch)\"",
            "python3 -I -c \"import json; from pathlib import Path; [Path(p).write_text('x') for p in Path('.').rglob('*.mjs')]\"",
            "sed -i 's/a/b/w scripts/a.mjs' config/shards.json",
            "sed -i 's/a/b/e' config/shards.json",
            "sed -i 's/a/b/' config/*.json",
            "sed -i 's/a/b/' alias.mjs",
            "sed -i 's/a/b/' hardlink.mjs",
            'cp other scripts', 'cp other alias.mjs',
        ]
        self.write('scripts/a.mjs', 'console.log(1)')
        (self.root / 'alias.mjs').symlink_to(self.root / 'scripts/a.mjs')
        os.link(self.root / 'scripts/a.mjs', self.root / 'hardlink.mjs')
        for edit in edits:
            with self.subTest(edit=edit):
                self.assertEqual(self.classify(prefix + edit + '\nnode --test scripts/a.mjs'), UNRESOLVED)

    def test_same_call_unproved_python_operations(self):
        rows = {
            'download': "import urllib.request\nurllib.request.urlretrieve('https://example.test/replacement.py', __file__)",
            'download alias': "from urllib.request import urlretrieve as fetch\nfetch('https://example.test/replacement.py', __file__)",
            'archive': "import zipfile\nzipfile.ZipFile('payload.zip').extractall('.')",
            'archive alias': "from zipfile import ZipFile as Archive\nArchive('payload.zip').extractall('.')",
            'local import': 'import updater',
            'local call': 'import updater\nupdater.update()',
            'local member': 'from updater import update\nupdate()',
            'unknown method': "import pathlib\npathlib.Path('x.py').touch()",
            'callback': "import json\nfrom urllib.request import urlretrieve\njson.dumps(object, default=urlretrieve)",
        }
        self.write('updater.py', 'print(1)')
        for label, body in rows.items():
            for interpreter in ['python3', 'python3 -I']:
                command = self.heredoc('tmp/x.py', body) + interpreter + ' tmp/x.py\n' + interpreter + ' tmp/x.py'
                with self.subTest(label=label, interpreter=interpreter):
                    self.assertEqual(self.classify(command), UNRESOLVED)
                    self.adapters(command, UNRESOLVED)
                    reason = guard.refusal_reason(*guard.classify_detail(command, str(self.root)), str(self.root))
                    self.assertRegex(reason, 'intervening command|interpreter startup')
                    self.assertNotIn('literal absolute', reason)

    def test_same_call_unittest_main_module_selection(self):
        # Source bytes only: neither the proposed runner nor this import-time
        # writer is executed by the classifier/adapter checks.
        self.write('updater.py', self.reporter_body('unittest-updater.py'))
        target = str(self.root / 'x.py')
        imports = [
            ('import unittest', 'unittest.main'),
            ('import unittest as tests', 'tests.main'),
            ('from unittest import main as run', 'run'),
        ]
        arguments = [
            ('', None),
            ("'__main__'", None),
            ("'updater'", UNRESOLVED),
            ("module='updater'", UNRESOLVED),
            ("module='__main__'", UNRESOLVED),
            ('None', UNRESOLVED),
            ('__name__', UNRESOLVED),
            ("*['updater']", UNRESOLVED),
            ("**{'module': 'updater'}", UNRESOLVED),
            ("'__main__', 'updater'", UNRESOLVED),
            ("'__main__', argv=['x.py', 'discover']", UNRESOLVED),
            ("'__main__', testLoader=unittest.defaultTestLoader", UNRESOLVED),
        ]
        for source_import, function in imports:
            for args, expected in arguments:
                body = source_import + '\n' + function + '(' + args + ')'
                for interpreter in ['python3', 'python3 -I']:
                    for setup, script in [('', target), ('d=$(mktemp -d)\n', '"$d/x.py"')]:
                        command = setup + self.heredoc(script, body) + interpreter + ' ' + script + '\n' + interpreter + ' ' + script
                        with self.subTest(function=function, args=args, interpreter=interpreter, script=script):
                            result = UNRESOLVED if interpreter == 'python3' else expected
                            self.assertEqual(self.classify(command), result)
                            self.adapters(command, result)
            for options in ['discover', 'updater', '-v']:
                body = source_import + '\n' + function + '()'
                run = 'python3 -I ' + target
                command = self.heredoc(target, body) + run + ' ' + options + '\n' + run
                with self.subTest(function=function, options=options):
                    self.assertEqual(self.classify(command), UNRESOLVED)
                    self.adapters(command, UNRESOLVED)

    def test_same_call_copy_replaces_opaque_source(self):
        seed = self.write('source/readback.ndjson', 'print(2)')
        for write_root in ['$d', '${d}']:
            for copy_root in ['$d', '${d}']:
                for destination in ['', 'readback.ndjson', './readback.ndjson', 'sibling.ndjson']:
                    for order in ['before', 'after']:
                        target = '"' + write_root + '/readback.ndjson"'
                        write = self.heredoc(target, 'print(1)')
                        copy = f'cp {seed} "{copy_root}/{destination}"\n'
                        command = 'd=$(mktemp -d)\n' + (copy + write if order == 'before' else write + copy) + 'python3 -I ' + target
                        expected = None if destination == 'sibling.ndjson' else UNRESOLVED
                        with self.subTest(write_root=write_root, copy_root=copy_root, destination=destination, order=order):
                            self.assertEqual(self.classify(command), expected)
                            self.adapters(command, expected)
                            if destination in {'', 'readback.ndjson'}:
                                rule, cause = guard.classify_detail(command, str(self.root))
                                self.assertRegex(cause, r'unchecked copy|executable provenance or mutation proof failed')
                                self.assertIn('Accepted:', guard.refusal_reason(rule, cause, str(self.root)))

    @trusted_node_test
    def test_same_call_checked_test_runners(self):
        target = str(self.root / 'skip.test.mjs')
        body = "import test from 'node:test'; test.skip('skip output', () => {});"
        run = f'node --test {target} 2>&1 | tail -2; node --test {target} 2>&1 | tail -1'
        command = self.heredoc(target, body) + run
        self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))
        self.adapters(command)
        for body in [body.replace("'node:test'", "'./unchecked.mjs'"), body + '\nimport "./unchecked.mjs";',
                     body.replace('() => {}', '() => { process.exit(1); }'), body + '\nprocess.dlopen({});']:
            command = self.heredoc(target, body) + run
            with self.subTest(body=body):
                self.assertEqual(self.classify(command), UNRESOLVED)
                self.adapters(command, UNRESOLVED)
        command = self.heredoc(target, "import fs from 'node:fs'; fs.readFileSync(" + repr(LIVE) + ");") + run
        self.assertEqual(self.classify(command), SCRIPT)
        self.adapters(command, SCRIPT)
        for runner in [f'node --test --import tmp/hook.mjs {target}', f'bun test --preload tmp/hook.mjs {target}']:
            command = self.heredoc(target, "import test from 'node:test'; test.skip('skip output', () => {});") + runner + '\nnode --test ' + target
            self.assertEqual(self.classify(command), UNRESOLVED)
            self.adapters(command, UNRESOLVED)

    def test_same_call_two_test_files(self):
        command = self.heredoc('test_one.py', 'import unittest\nclass T(unittest.TestCase):\n def test_one(self): self.assertTrue(True)')
        command += self.heredoc('test_two.py', 'import unittest\nclass U(unittest.TestCase):\n def test_two(self): self.assertTrue(True)')
        command += 'python3 -I -m unittest discover'
        rule, cause = guard.classify_detail(command, str(self.root))
        self.assertEqual(rule, UNRESOLVED, cause)
        self.assertIn('python: module startup unproved', cause)
        self.adapters(command, UNRESOLVED)

    def test_same_call_watchers47(self):
        # The heredoc-written suite runs only under `offbox run --bg`, so the box is the only reader.
        command = self.reporter_body('watchers47.sh')
        self.assertIsNone(self.classify(command))
        self.adapters(command, None)

    @trusted_node_test
    def test_same_call_literal_reporters(self):
        script = self.root / 'tmp/replay.py'
        replay = self.heredoc(str(script), self.reporter_body('replay.py'))
        run = f'python3 -I {script} {self.root}/tmp/before {self.root}/tmp/result'
        batches = {
            'A single': replay + run + ' > tmp/before.json',
            'checked rerun': self.heredoc(str(script), 'import json\nprint(json.dumps(dict(count=1)))') + run + '\n' + run,
            'A sibling': replay + 'git show HEAD:src/tool.py > tmp/sibling.py\n' + run,
            'A copy to sibling': replay + f'cp {script} tmp/sibling.py\n' + run,
            'A reconstructed': 'mkdir tmp/before\ngit show HEAD:src/tool.py > tmp/before/tool.py\n' + replay + 'git show HEAD:src/reader.py > tmp/sibling.py\n' + run + ' > tmp/before.json',
            'D2 single': self.heredoc(str(self.root / 'tmp/report.py'), self.reporter_body('report.py')) + 'unset BUN_INSPECT\npython3 -I tmp/report.py tmp/credential.json',
        }
        for label, command in batches.items():
            with self.subTest(label=label):
                if label in {'A sibling', 'A reconstructed'}:
                    self.assertEqual(self.classify(command), UNRESOLVED)
                else:
                    self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))
        # DB-safe is not a source-preservation proof for unchecked imports.
        self.assertEqual(self.classify(replay + run + '\n' + run), UNRESOLVED)
        for interpreter in ['bun', 'node']:
            prefix = self.heredoc('tmp/readback.ts', self.reporter_body('readback.ts'))
            run = interpreter + ' tmp/readback.ts tmp/some.ndjson'
            self.assertEqual(self.classify(prefix + run + '\n' + run), UNRESOLVED if interpreter == 'bun' else None)

    def test_same_call_fresh_reporters(self):
        for variable in ['$d', '${d}']:
            for separator in ['\n', '; ']:
                for setup in ['', 'set -euo pipefail\n']:
                    for binary, filename in [('bun', 'readback.ts'), ('node', 'readback.ts'), ('python3', 'report.py'), ('python3 -I', 'report.py')]:
                        target = '"' + variable + '/' + filename + '"'
                        body = self.reporter_body(filename)
                        prefix = setup + 'd=$(mktemp -d)' + separator + 'cp /fixtures/some.ndjson "' + variable + '/"' + separator
                        run = binary + ' ' + target + ' tmp/credential.json'
                        command = prefix + self.heredoc(target, body) + run + separator + run
                        with self.subTest(variable=variable, separator=separator, setup=setup, binary=binary):
                            # An empty-root directory copy has unbounded tool
                            # aliases; later cat cannot restore tool evidence.
                            self.assertEqual(self.classify(command), UNRESOLVED)
        # Quoting is required: IFS and glob expansion are not proved by mktemp.
        command = 'd=$(mktemp -d); ' + self.heredoc('"$d/report.py"', self.reporter_body('report.py')) + 'python3 -I $d/report.py'
        self.assertEqual(self.classify(command), UNRESOLVED)

    def test_same_call_unittest_reporters(self):
        for relative, filename in [('integrations/robob-watch/checks/money-cases', 'test_order_charges.py'), ('integrations/memory-system/tests', 'test_state_lineage_logging.py')]:
            for absolute_write in [False, True]:
                target = relative + '/' + filename
                if absolute_write:
                    target = str(self.root / target)
                prefix = self.heredoc(target, self.reporter_body(filename))
                runners = [
                    f'python3 -m unittest discover -s {relative}',
                    f'python3 -I -m unittest discover -s {relative} -p \'test_*.py\' -t . -v',
                    f'cd {relative} && python3 -m unittest discover',
                    f'python3 {self.root / relative / filename}',
                ]
                if filename == 'test_state_lineage_logging.py':
                    runners.append('cd integrations/memory-system && python3 -m unittest discover -s tests')
                for runner in runners:
                    for preparation in ['', 'unset BUN_INSPECT\n']:
                        command = prefix + preparation + runner
                        with self.subTest(target=target, runner=runner, preparation=preparation):
                            self.assertEqual(self.classify(command), UNRESOLVED)
        simple = 'import tempfile, unittest\nclass Fixture(unittest.TestCase):\n def test_fixture(self):\n  with tempfile.TemporaryDirectory() as root:\n   self.assertTrue(root)\n'
        prefix = self.heredoc('tmp/test_fixture.py', simple)
        run = 'python3 -I -m unittest discover -s tmp'
        self.assertEqual(self.classify(prefix + run + '\n' + run), UNRESOLVED)

    def test_same_call_mktemp_reporters(self):
        body = ('import tempfile, unittest\nclass T(unittest.TestCase):\n'
                ' def test_fixture(self):\n  with tempfile.TemporaryDirectory() as root:\n'
                '   self.assertTrue(root)\n')
        self.write('other_existing.py', 'import unittest\n')
        venv = '/Users/ardud/.local/share/memory-system/.venv/bin/python3'
        rows = [
            ('recall73', 'x.py', f'A=1 B=$(mktemp -d) {venv} -m unittest x other_existing'),
            ('recall93', 'x.py', 'B=$(mktemp -d) A=1 ~/.local/share/memory-system/.venv/bin/python3 -m unittest x'),
            ('system', 'x.py', 'A=1 B=$(mktemp -d) python3 -m unittest x'),
            ('isolated', 'x.py', 'B=$(mktemp -d) python3 -I x.py'),
            ('template', 'x.py', 'B=$(mktemp -d -t foo.XXXXXX) python3 -I x.py'),
            ('recall52', 'integrations/memory-system/tests/test_backup_partial.py',
             f'RECALL_RULE_PREFLIGHT=1 RECALL_TOOL_LOG_DIR=$(mktemp -d) {venv} -m unittest discover -s integrations/memory-system/tests -p test_backup_partial.py'),
            ('recall115', 'test_backup_io.py', 'RECALL_RULE_PREFLIGHT=1 RECALL_TOOL_LOG_DIR=$(mktemp -d) ~/.local/share/memory-system/.venv/bin/python3 -m unittest test_backup_io'),
            ('recall94', 'integrations/memory-system/tests/test_backup_shipper.py', 'RECALL_TOOL_LOG_DIR=$(mktemp -d) python3 -m unittest discover -s integrations/memory-system/tests -p test_backup_shipper.py -v'),
            ('recall94 standalone', 'integrations/memory-system/tests/test_backup_shipper.py', 'D=$(mktemp -d)\nRECALL_TOOL_LOG_DIR="$D" python3 -m unittest discover -s integrations/memory-system/tests -p test_backup_shipper.py -v'),
            ('recall122', 'integrations/memory-system/tests/test_backup_manifest.py', 'RECALL_TOOL_LOG_DIR=$(mktemp -d) /usr/bin/python3 -m unittest discover -s integrations/memory-system/tests -p test_backup_manifest.py'),
        ]
        for label, target, runner in rows:
            source = body
            directory = self.root
            if label == 'recall115':
                directory = self.root / 'integrations/memory-system/tests'
                directory.mkdir(parents=True, exist_ok=True)
                self.write('integrations/memory-system/src/synthetic_backup.py', 'def copy(): pass\n')
                source = 'import sys\nsys.path.insert(0, "../src")\nfrom synthetic_backup import copy\nfrom unittest import mock\n' + body
            command = self.heredoc(target, source) + runner
            with self.subTest(reporter=label):
                rule, cause = guard.classify_detail(command, str(directory))
                expected = None if label in {'isolated', 'template'} else UNRESOLVED
                self.assertEqual(rule, expected, cause)
                if expected:
                    self.assertIn('python: non-isolated startup', cause)
                else:
                    self.assertIsNone(cause)
                self.adapters('cd ' + shlex.quote(str(directory)) + ' && ' + command, expected)

    def test_same_call_mktemp_substitution_forms(self):
        prefix = self.heredoc('x.py', 'print(1)')
        for substitution in ['mktemp -d', 'mktemp -d foo.XXXXXX', 'mktemp -d -t foo.XXXXXX',
                             'mktemp -d "foo.XXXXXX"', '/usr/bin/mktemp -d']:
            for assignment in [f'B=$({substitution})', f'B="$({substitution})"']:
                for setup in [assignment + ' ', 'A=1 ' + assignment + ' C=2 ', assignment + '\n']:
                    command = prefix + setup + 'python3 -I x.py'
                    with self.subTest(substitution=substitution, setup=setup):
                        self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))

    def test_same_call_mktemp_substitution_still_denies(self):
        prefix = self.heredoc('x.py', 'print(1)')
        for substitution in ['cp other.py x.py', 'sed -i s/1/2/ x.py', 'tee x.py < other.py',
                             'mktemp -u', 'mktemp -d -u', 'mktemp -d --dry-run', 'python3 unchecked.py',
                             'mktemp -d; cp other.py x.py', 'mktemp -d > x.py',
                             'mktemp -d $(python3 unchecked.py)', 'mktemp -d "$TEMPLATE"',
                             'mktemp -d; true', 'mktemp -d | cat']:
            for setup in [f'B=$({substitution}) ', f'B=$({substitution})\n']:
                command = prefix + setup + 'python3 -I x.py'
                with self.subTest(substitution=substitution, setup=setup):
                    self.assertIsNotNone(self.classify(command))
        for database in [LIVE, '/Users/x/.local/share/opencode/opencode.db']:
            command = self.heredoc('x.py', f'open({database!r}, "rb").read()') + 'B=$(mktemp -d) python3 -I x.py'
            self.assertEqual(self.classify(command), SCRIPT)
        for setup in ['PATH=/untrusted B=$(mktemp -d) ', 'mktemp() { cp other.py x.py; }\nB=$(mktemp -d) ',
                      'alias mktemp="cp other.py x.py"\nB=$(mktemp -d) ',
                      'cp other.py /usr/bin/mktemp\nB=$(mktemp -d) ']:
            self.assertIsNotNone(self.classify(prefix + setup + 'python3 -I x.py'))
        command = prefix + 'B=$(mktemp -d) python3 -I x.py'
        with patch.dict(os.environ, {'BASH_FUNC_mktemp%%': '() { cp other.py x.py; }'}):
            self.assertIsNotNone(self.classify(command))
        with patch.object(guard, '_trusted_fixture_tool', return_value=False):
            self.assertIsNotNone(self.classify(command))

    def test_same_call_offbox_reporter(self):
        relative = 'integrations/memory-system/tests/benchmark_recall_storage.py'
        for destination in [relative, str(self.root / relative)]:
            for target in [relative, str(self.root / relative)]:
                for binary in ['python3', 'python3 -I']:
                    for wrapper in ['', 'offbox run -- ', 'offbox run --bg --size xlarge -- ']:
                        prefix = self.heredoc(destination, self.reporter_body('benchmark_recall_storage.py'))
                        command = prefix + 'git show HEAD:src/storage.py > tmp/baseline.py\n' + wrapper + binary + ' ' + target
                        with self.subTest(destination=destination, target=target, binary=binary, wrapper=wrapper):
                            # --bg runs the script only on the box (#221).
                            self.assertEqual(self.classify(command), None if '--bg' in wrapper else UNRESOLVED)
        body = 'import os, sqlite3, tempfile\nwith tempfile.TemporaryDirectory() as tmp:\n sqlite3.connect(os.path.join(tmp, "bench.db"))\n'
        rule, cause = guard.classify_detail(self.heredoc(relative, body) + 'offbox run -- python3 ' + relative, str(self.root))
        self.assertEqual(rule, UNRESOLVED, cause)
        self.assertIn('python: non-isolated startup', cause)

    @trusted_node_test
    def test_same_call_offbox_steps_keep_wrapper_proof(self):
        for runner, filename, body in [('python3 -I', 'step.py', 'print(1)'),
                                       ('node', 'step.mjs', 'console.log(1)'),
                                       ('bash', 'step.sh', 'echo ok')]:
            prefix = self.heredoc('tmp/' + filename, body)
            step = shlex.quote(runner + ' tmp/' + filename)
            for flags in ['--step ' + step, '--step=' + step,
                          '--step true --step ' + step]:
                command = prefix + 'offbox run ' + flags
                with self.subTest(runner=runner, flags=flags):
                    rule, cause = guard.classify_detail(command, str(self.root))
                    if flags.count('--step') > 1:
                        # Several steps run as one '; '-joined remote string (#221).
                        self.assertIsNone(rule, cause)
                        self.adapters(command, None)
                        continue
                    self.assertEqual(rule, UNRESOLVED, cause)
                    self.assertIn('command wrapper proof failed', cause)
                    self.adapters(command, UNRESOLVED)

    def test_same_call_still_refuses_rewrites(self):
        target = str(self.root / 'tmp/replay.py')
        prefix = self.heredoc(target, 'print(1)')
        changes = [
            f'echo {shlex.quote("import sqlite3; sqlite3.connect(" + repr(LIVE) + ")")} >> {target}',
            f'cp /other/evil.py {target}', f'sed -i s/1/2/ {target}',
            f'curl -o {target} https://example.test/x', f'curl https://example.test/x > {target}',
            f'git show HEAD:other.py > {target}', f'cat /other/evil.py >> {target}',
            'python3 -I tmp/other.py', 'python3 -m some_local_module',
            'offbox run -- python3 -I tmp/other.py', 'offbox run -- unknown-program',
        ]
        for change in changes:
            with self.subTest(change=change):
                self.assertIsNotNone(self.classify(prefix + change + '\npython3 -I ' + target))
        for body in ['from pathlib import Path\nPath(__file__).write_text("print(2)")', 'open(__file__, "w").write("print(2)")', 'import sys\nopen(sys.argv[0], "w").write("print(2)")']:
            command = self.heredoc(target, body) + f'python3 -I {target}\npython3 -I {target}'
            with self.subTest(body=body):
                self.assertEqual(self.classify(command), UNRESOLVED)
        for body in ['writer = open\nwriter(__file__, "w").write("print(2)")', 'from io import open as writer\nwriter(__file__, "w").write("print(2)")', 'from pathlib import Path\nPath(sys.argv[1]).write_text("print(2)")']:
            command = self.heredoc(target, body) + f'python3 -I {target}\npython3 -I {target}'
            self.assertEqual(self.classify(command), UNRESOLVED)
        relative = 'integrations/memory-system/tests/test_state_lineage_logging.py'
        for change in [f'sed -i s/1/2/ {relative}', f'cat /other/evil.py >> {relative}', 'python3 -m some_local_module']:
            command = self.heredoc(relative, 'print(1)') + change + '\npython3 -m unittest discover -s integrations/memory-system/tests'
            self.assertEqual(self.classify(command), UNRESOLVED)

    def test_same_call_fresh_fail_closed(self):
        for setup in ['d=$(mktemp -d)', '[ -n "$x" ] && d=$(mktemp -d)', 'd=$(mktemp -d); d=$OTHER']:
            for binary, filename in [('bun', 'readback.ts'), ('python3 -I', 'report.py')]:
                run = binary + ' "$d/' + filename + '"'
                with self.subTest(setup=setup, binary=binary):
                    self.assertEqual(self.classify(setup + '; ' + run), UNRESOLVED)
                    self.assertEqual(self.classify(setup + '; cp /abs/unchecked.ts "$d/' + filename + '"; ' + run), UNRESOLVED)
                    if setup != 'd=$(mktemp -d)':
                        self.assertEqual(self.classify(setup + '; ' + self.heredoc('"$d/' + filename + '"', 'print(1)') + run), UNRESOLVED)
        for filename, run in [('report.py', 'python3 -I'), ('readback.ts', 'bun')]:
            command = 'd=$(mktemp -d); ' + self.heredoc('"$d/' + filename + '"', 'import sqlite3; sqlite3.connect(' + repr(LIVE) + ')') + run + ' "$d/' + filename + '"'
            self.assertEqual(self.classify(command), SCRIPT)

    @trusted_node_test
    def test_mktemp_109_templates_and_inline_invocations(self):
        templates = ['', ' tmp/work.XXXXXX', ' -t work', ' ~/.robob/board-artifacts/work.XXXXXX',
                     ' "$HOME/.robob/board-artifacts/work.XXXXXX"', ' "$PWD/tmp/work.XXXXXX"']
        for template in templates:
            for binary, filename, body in [('python3 -I', 'x.py', 'print(1)'), ('node', 'x.js', 'console.log(1)'), ('bash', 'x.sh', 'echo hi')]:
                for wrapper in ['', 'offbox run -- ', 'offbox run --include "$d" -- ',
                                'offbox run --include="$d" --bg --no-fallback --size xlarge -- ']:
                    setup = 'd=$(mktemp -d' + template + ')\n'
                    command = setup + self.heredoc('"$d/' + filename + '"', body) + wrapper + binary + ' "$d/' + filename + '"'
                    with self.subTest(template=template, binary=binary, wrapper=wrapper):
                        self.assertEqual(self.classify(command), UNRESOLVED if wrapper and '--bg' not in wrapper else None)
                for wrapper in ['', 'offbox run -- ']:
                    command = wrapper + binary + ' "$(mktemp -d' + template + ')/' + filename + '"'
                    self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None), command)
        # Expanding a previously bound directory cannot use the empty-dir proof.
        for wrapper in ['', 'offbox run -- ']:
            self.assertEqual(self.classify('d=$(mktemp -d); ' + wrapper + 'python3 "$d/x.py"'), UNRESOLVED)
        for template in [' -u', ' -u tmp/x.XXXXXX', ' -t /outside/x', ' tmp/../x.XXXXXX',
                         ' ~/.robob/userdata/x.XXXXXX', ' ~/.t3/userdata/x.XXXXXX',
                         ' ~/.local/share/opencode/x.XXXXXX', ' "$(echo tmp)/x.XXXXXX"']:
            for wrapper in ['', 'offbox run -- ']:
                command = 'd=$(mktemp -d' + template + '); ' + self.heredoc('"$d/x.py"', 'print(1)') + wrapper + 'python3 "$d/x.py"'
                self.assertEqual(self.classify(command), UNRESOLVED, command)
                self.assertEqual(self.classify(wrapper + 'python3 "$(mktemp -d' + template + ')/x.py"'), UNRESOLVED)

    def test_mktemp_109_sibling_writers_and_heredoc_spellings(self):
        for writer in ['echo hi > "$d/other"', 'printf "%s\\n" hi > "$d/other"', 'cp /source/bundle.tgz "$d/bundle.tgz"',
                       self.heredoc('"$d/other"', 'hello'), 'print -r -- "$d" > tmp/path.txt',
                       'printf "%s\\n" "$d/x.py" > tmp/path.txt']:
            for before in [True, False]:
                script = self.heredoc('"$d/x.py"', 'print(1)')
                prefix = 'd=$(mktemp -d)\n' + (writer + '\n' + script if before else script + writer + '\n')
                for wrapper in ['', 'offbox run -- ']:
                    command = prefix + wrapper + 'python3 -I "$d/x.py"'
                    self.assertEqual(self.classify(command), UNRESOLVED if wrapper else None, command)
        for writer in ['cat > "$d/x.py"', 'cat <<\'EOF\' > "$d/x.py"', 'tee "$d/x.py"']:
            header = writer if '<<' in writer else writer + " <<'EOF'"
            command = 'd=$(mktemp -d)\n' + header + '\nprint(1)\nEOF\npython3 -I "$d/x.py"'
            self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None), command)
        command = 'd=$(mktemp -d); ' + self.heredoc('"$d/x.sh"', "python3 - <<'PY'\nprint(1)\nPY")
        self.assertEqual(self.classify(command + 'chmod +x "$d/x.sh"; offbox run --include "$d" -- bash "$d/x.sh"'), UNRESOLVED)
        command = 'd=$(mktemp -d); ' + self.heredoc('"$d/x.py"', 'print(1)')
        self.assertIsNone(self.classify(command + 'cp "$d/x.py" tmp/copy.py; python3 -I "$d/x.py"'))

    def test_mktemp_109_tee_output_aliases(self):
        for input_text in [' < tmp/t.py', ' <<< hi']:
            for write_root in ['$d', '${d}']:
                for run_root in ['$d', '${d}']:
                    for target, expected in [('x.py', UNRESOLVED), ('other', None)]:
                        for before in [True, False]:
                            for wrapper in ['', 'offbox run -- ']:
                                writer = 'tee "' + write_root + '/' + target + '"' + input_text + '\n'
                                script = self.heredoc('"' + run_root + '/x.py"', 'print(1)')
                                command = 'd=$(mktemp -d)\n' + (writer + script if before else script + writer)
                                command += wrapper + 'python3 -I "' + run_root + '/x.py"'
                                with self.subTest(command=command):
                                    self.assertEqual(self.classify(command), UNRESOLVED if wrapper else expected)

    def test_mktemp_109_filesystem_alias_writers(self):
        # Compare identities before files exist, independently of the test host's
        # case/normalization behavior. Local and offbox must use the same proof.
        rows = [
            ('x.py', 'X.py', UNRESOLVED),
            ('café.py', 'cafe\u0301.py', UNRESOLVED),
            ('café.py', 'CAFE\u0301.PY', UNRESOLVED),
            ('sub/x.py', 'SUB/X.PY', UNRESOLVED),
            ('x.py', 'other.py', None),
            ('x.py', 'x.py.backup', None),
            ('café.py', 'cafe.py', None),
        ]
        for script_name, target, expected in rows:
            for writer in ['cp /source/unchecked.py "{target}"', 'echo hi > "{target}"',
                           'tee "{target}" < tmp/input.py']:
                for root in ['$d', '${d}']:
                    for before in [False, True]:
                        script = self.heredoc('"$d/' + script_name + '"', 'print(1)')
                        write = writer.format(target=root + '/' + target) + '\n'
                        prefix = 'd=$(mktemp -d)\nmkdir "$d/sub"\n'
                        prefix += write + script if before else script + write
                        for wrapper in ['', 'offbox run --include "$d" --pull tmp/log -- ']:
                            command = prefix + wrapper + 'python3 -I "$d/' + script_name + '"'
                            with self.subTest(command=command):
                                rule, cause = guard.classify_detail(command, str(self.root))
                                self.assertEqual(rule, UNRESOLVED if wrapper else expected)
                                if expected:
                                    self.assertIn('Accepted:', cause)
                                    self.assertIn('copy' if writer.startswith('cp') else 'writer', cause)
        # cp to an existing directory writes the source basename beneath it.
        for target in ['sub', 'SUB', 'sub/', 'SUB/']:
            for before in [False, True]:
                script = self.heredoc('"$d/sub/unchecked.py"', 'print(1)')
                write = 'cp /source/unchecked.py "$d/' + target + '"\n'
                prefix = 'd=$(mktemp -d)\nmkdir "$d/sub"\n'
                prefix += write + script if before else script + write
                for wrapper in ['', 'offbox run -- ']:
                    command = prefix + wrapper + 'python3 -I "$d/sub/unchecked.py"'
                    self.assertEqual(self.classify(command), UNRESOLVED, command)

    def test_mktemp_109_print_binding_changes(self):
        script = self.heredoc('"$d/x.py"', 'print(1)')
        writers = ['print -v d -- /literal/existing-directory',
                   'print -rv d -- /literal/existing-directory',
                   'print -vr d -- /literal/existing-directory',
                   'print -r -v d -- /literal/existing-directory',
                   'print -vd -- /literal/existing-directory',
                   'print "$FLAGS" d /literal/existing-directory',
                   'print -v PATH -- /literal/bin',
                   'print -v BASH_ENV -- /literal/startup']
        for writer in writers:
            for before in [False, True]:
                prefix = 'd=$(mktemp -d)\n' + (writer + '\n' + script if before else script + writer + '\n')
                for wrapper in ['', 'offbox run -- ']:
                    command = prefix + wrapper + 'python3 -I "$d/x.py"'
                    with self.subTest(command=command):
                        rule, cause = guard.classify_detail(command, str(self.root))
                        self.assertEqual(rule, UNRESOLVED)
                        self.assertIn('print flags may reassign', cause)
                        self.assertIn('at line', cause)
                        self.assertIn('Accepted:', cause)
        for operand in ['"$d"', '-v', '-rv', '"$FLAGS"']:
            for wrapper in ['', 'offbox run -- ']:
                command = 'd=$(mktemp -d)\n' + script + 'print -r -- ' + operand + ' > tmp/path.txt\n'
                command += wrapper + 'python3 -I "$d/x.py"'
                self.assertEqual(self.classify(command), UNRESOLVED if wrapper else None, command)

    def test_mktemp_109_print_binding_changes_in_loops(self):
        setup = 'd=$(mktemp -d)\n' + self.heredoc('"$d/x.py"', 'print(1)')
        forms = ['{print}', '! {print}', 'if true; then {print}; fi', 'command {print}',
                 'command -p -- {print}', 'builtin {print}', 'noglob {print}', 'nocorrect {print}',
                 '{{ {print}; }}', 'if true; then {{ {print}; }}; fi',
                 'case "$n" in *) {print};; esac', 'case "$n" in 1|2) {{ {print}; }};; esac',
                 'time {print}', 'time -p {print}', '! time {{ {print}; }}',
                 '{{ time {print}; }}', 'time case "$n" in *) {print};; esac',
                 '! time if true; then {{ {print}; }}; fi',
                 'time for j in 1 2; do {print}; done']
        for flags in ['-v d --', '-rv d --', '-vr d --', '-r -v d --', '-vd --', '"$FLAGS" d', '-v PATH --']:
            for form in forms:
                mutation = form.format(print='print ' + flags + ' /literal/rebound')
                for wrapper in ['', 'offbox run -- ']:
                    body = 'for n in 1 2; do\n' + wrapper + 'python3 -I "$d/x.py"\n' + mutation + '\ndone'
                    commands = [setup + body]
                    if not wrapper:
                        commands.append('offbox run -- ' + shlex.quote(setup + body))
                    for command in commands:
                        with self.subTest(command=command):
                            rule, cause = guard.classify_detail(command, str(self.root))
                            if remote_only_offbox(command):
                                self.assertIsNone(rule, cause)
                                continue
                            self.assertEqual(rule, UNRESOLVED)
                            self.assertRegex(cause, 'print flags may reassign|command wrapper proof failed')
                            self.assertRegex(cause, 'in a loop at line|interpreter startup')
                            self.assertIn('Accepted:', cause)
        for operand in ['"$d"', '-v', '-rv']:
            for form in [forms[i] for i in [0, 1, 2, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]]:
                for wrapper in ['', 'offbox run -- ']:
                    output = form.format(print='print -r -- ' + operand)
                    command = setup + 'for n in 1 2; do\n' + wrapper + 'python3 -I "$d/x.py"\n' + output + '\ndone'
                    rule, cause = guard.classify_detail(command, str(self.root))
                    self.assertEqual(rule, UNRESOLVED, cause)
                    self.assertRegex(cause, 'provenance or mutation proof failed|command wrapper proof failed')
                    if not wrapper:
                        # A multi-line payload only runs on the box (#221).
                        self.assertEqual(guard.classify_detail('offbox run -- ' + shlex.quote(command), str(self.root)), (None, None))

    def test_mktemp_109_loop_prefixes_and_case_patterns(self):
        setup = 'd=$(mktemp -d)\n' + self.heredoc('"$d/x.py"', 'print(1)')
        forms = [prefix + ' for n in 1 2; do\n{invoke}\n{print}\ndone'
                 for prefix in ['!', 'time', 'time -p', '! time', 'time !']]
        keywords = ['if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'select',
                    'do', 'done', 'case', 'esac', 'in', '!', 'time']
        for keyword in keywords:
            for pattern in [keyword, "'" + keyword + "'", '"' + keyword + '"']:
                for opening in ['', '(']:
                    forms.append('for n in 1 2; do\n{invoke}\ncase "$n" in\n'
                                 + opening + pattern + '|1|2) {print};;\nesac\ndone')
        # A keyword argument must not extend or truncate the matching loop.
        forms.append('for n in 1 2; do\necho for done\n{invoke}\n{print}\ndone')
        for flags in ['-v d --', '-rv d --', '"$FLAGS" d', '-v PATH --', '-r --']:
            output_only = flags == '-r --'
            for form in forms:
                for wrapper in ['', 'offbox run -- ']:
                    body = form.format(invoke=wrapper + 'python3 -I "$d/x.py"',
                                       print='print ' + flags + ' /literal/rebound')
                    commands = [setup + body]
                    if not wrapper:
                        commands.append('offbox run -- ' + shlex.quote(setup + body))
                    for command in commands:
                        with self.subTest(command=command):
                            rule, cause = guard.classify_detail(command, str(self.root))
                            if remote_only_offbox(command):
                                self.assertIsNone(rule, cause)
                                continue
                            if output_only and (wrapper or command.startswith('offbox run -- ')):
                                self.assertEqual(rule, UNRESOLVED, cause)
                                self.assertIn('command wrapper proof failed', cause)
                            elif output_only and 'echo for done' in form:
                                self.assertEqual(rule, UNRESOLVED, cause)
                                self.assertIn('executable provenance or mutation proof failed', cause)
                            elif output_only:
                                self.assertEqual(rule, UNRESOLVED, cause)
                                self.assertIn('executable provenance or mutation proof failed', cause)
                            else:
                                self.assertEqual(rule, UNRESOLVED)
                                self.assertRegex(cause, 'print flags may reassign|command wrapper proof failed')
                                self.assertRegex(cause, 'in a loop at line|interpreter startup')
                                self.assertIn('Accepted:', cause)

    def test_mktemp_109_case_arm_separators(self):
        unsafe = self.write('case-unsafe.py', f'open({LIVE!r}).read()')
        setup = 'd=$(mktemp -d)\n' + self.heredoc('"$d/x.py"', 'print(1)')
        for separator in [';;', ';&', ';|', ';;&']:
            for opening in ['', '(']:
                for arm_break, command_break in [(' ', ' '), ('\n', ' '), (' ', '\n')]:
                    for wrapper in ['', 'offbox run -- ']:
                        tail = separator + arm_break + opening + '1|2)' + command_break + '{command};; esac'
                        direct = 'case 1 in 1) : ' + tail.format(command=wrapper + f'python3 -I "{unsafe}"')
                        commands = [direct]
                        if not wrapper:
                            commands.append('offbox run -- ' + shlex.quote(direct))
                        for command in commands:
                            with self.subTest(command=command):
                                self.assertEqual(self.classify(command), None if remote_only_offbox(command) else SCRIPT)
                        for flags in ['-v d --', '-rv d --', '"$FLAGS" d', '-v PATH --', '-r --']:
                            mutation = 'case "$n" in 1) : ' + tail.format(command='print ' + flags + ' /literal/rebound')
                            loop = setup + 'for n in 1 2; do\n' + wrapper + 'python3 -I "$d/x.py"\n' + mutation + '\ndone'
                            commands = [loop]
                            if not wrapper:
                                commands.append('offbox run -- ' + shlex.quote(loop))
                            for command in commands:
                                with self.subTest(command=command):
                                    rule, cause = guard.classify_detail(command, str(self.root))
                                    if remote_only_offbox(command):
                                        self.assertIsNone(rule, cause)
                                        continue
                                    if flags == '-r --' and (wrapper or command.startswith('offbox run -- ')):
                                        self.assertEqual(rule, UNRESOLVED, cause)
                                        self.assertIn('command wrapper proof failed', cause)
                                    elif flags == '-r --':
                                        self.assertEqual(rule, UNRESOLVED, cause)
                                        self.assertIn('executable provenance or mutation proof failed', cause)
                                    else:
                                        self.assertEqual(rule, UNRESOLVED)
                                        self.assertRegex(cause, 'print flags may reassign|command wrapper proof failed')
                                        self.assertRegex(cause, 'in a loop at line|interpreter startup')
                                        self.assertIn('Accepted:', cause)

    def test_mktemp_109_case_fallthrough_cwd(self):
        safe = self.write('arm.py', 'print(1)')
        self.write('sub/arm.py', f'open({LIVE!r}).read()')
        for separator in [';;', ';&', ';|', ';;&']:
            for opening in ['', '(']:
                for arm_break, command_break in [(' ', ' '), ('\n', ' '), (' ', '\n')]:
                    tail = separator + arm_break + opening + '1|2)' + command_break + '{command};; esac'
                    for wrapper in ['', 'offbox run -- ']:
                        for path in ['arm.py', str(safe)]:
                            case = 'case 1 in 1) cd sub ' + tail.format(command=wrapper + f'python3 -I "{path}"')
                            commands = [case]
                            if not wrapper:
                                commands.append('offbox run -- ' + shlex.quote(case))
                            for command in commands:
                                with self.subTest(command=command):
                                    rule, cause = guard.classify_detail(command, str(self.root))
                                    if remote_only_offbox(command):
                                        self.assertIsNone(rule, cause)
                                        continue
                                    if separator == ';;' or path == str(safe):
                                        self.assertIsNone(rule, cause)
                                    else:
                                        self.assertEqual(rule, UNRESOLVED)
                                        self.assertIn('directory changed', cause)
                    for quote in ['', "'"]:
                        pattern = quote + '$(python3 -I arm.py)' + quote + '|1|2'
                        case = 'case 1 in 1) cd sub ' + separator + arm_break + opening + pattern + ') :;; esac'
                        for command in [case, 'offbox run -- ' + shlex.quote(case)]:
                            with self.subTest(command=command):
                                rule, cause = guard.classify_detail(command, str(self.root))
                                if separator == ';;' or quote or remote_only_offbox(command):
                                    self.assertIsNone(rule, cause)
                                else:
                                    self.assertEqual(rule, UNRESOLVED)
                                    self.assertIn('continuing case arms', cause)
        # A terminating alternative restores the original entry cwd even after
        # earlier continuing arms made their own entry cwd ambiguous.
        self.assertIsNone(self.classify('case 1 in 1) cd sub ;& 2) :;; 3) python3 -I arm.py;; esac'))

    def test_loop_cwd_enclosing_boundaries(self):
        safe = self.write('arm.py', 'print(1)')
        self.write('sub/arm.py', f'open({LIVE!r}).read()')
        structures = [
            'case 1 in 1) for j in 1; do {body}; done;; esac',
            'case 1 in 1) while false; do {body}; done;; esac',
            'case 1 in 1) until true; do {body}; done;; esac',
            'case 1 in 1) select j in 1; do {body}; done;; esac',
            'if true; then for j in 1; do {body}; done; fi',
            'for a in 1; do for b in 1; do {body}; done; done',
            'case 1 in 1) if true; then for j in 1; do {body}; done; fi;; esac',
        ]
        for structure in structures:
            for body, tail, expected in [
                ('cd sub', 'python3 -I arm.py', UNRESOLVED),
                (':', 'python3 -I arm.py', None),
                ('cd sub', 'python3 -I ' + shlex.quote(str(safe)), None),
                ('cd sub', 'cd ' + shlex.quote(str(self.root)) + '; python3 -I arm.py', None),
            ]:
                command = structure.format(body=body) + '; ' + tail
                for wrapped in [command, command.replace('python3 -I ', 'offbox run -- python3 -I '),
                                'offbox run -- ' + shlex.quote(command)]:
                    with self.subTest(command=wrapped):
                        rule, cause = guard.classify_detail(wrapped, str(self.root))
                        # The box runs a remote-only payload; sub/arm.py never reaches the Mac.
                        expected_here = None if remote_only_offbox(wrapped) else expected
                        self.assertEqual(rule, expected_here, cause)
                        if expected_here:
                            self.assertTrue(any(part in cause for part in [
                                'directory changed', 'a loop that changes directory',
                            ]), cause)

    def test_loop_cwd_enclosing_independent_alternatives(self):
        self.write('arm.py', 'print(1)')
        self.write('sub/arm.py', f'open({LIVE!r}).read()')
        for command in [
            'case x in a) for j in 1; do cd sub; done;; b) python3 -I arm.py;; esac',
            'if true; then for j in 1; do cd sub; done; else python3 -I arm.py; fi',
            'if true; then for j in 1; do cd sub; done; elif false; then python3 -I arm.py; fi',
        ]:
            # An independent entry must not restore the enclosing exit.
            for tail, expected in [('', None), ('; python3 -I arm.py', UNRESOLVED)]:
                full = command + tail
                for wrapped in [full, full.replace('python3 -I ', 'offbox run -- python3 -I '),
                                'offbox run -- ' + shlex.quote(full)]:
                    with self.subTest(command=wrapped):
                        self.assertEqual(guard.classify(wrapped, str(self.root)),
                                         None if remote_only_offbox(wrapped) else expected)

    def test_loop_cwd_enclosing_relative_database_reads(self):
        roots = [
            ('/Users/x/.robob/userdata', 'statev2.sqlite'),
            (str(Path.home() / '.t3/userdata'), 'state.sqlite'),
            ('/Users/x/.local/share/opencode', 'opencode.db'),
        ]
        for root, name in roots:
            for suffix in ['', '-wal', '-shm', '-journal']:
                operand = name + suffix
                readers = [
                    'python3 -I -c ' + shlex.quote(f'open({operand!r}).read()'),
                    'node -e ' + shlex.quote(f'require("fs").readFileSync({operand!r})'),
                    'cat ' + operand,
                    'sqlite3 ' + operand + ' .schema',
                    'cat < ' + operand,
                    "python3 -I <<'PY'\n" + f'open({operand!r}).read()\nPY\n',
                ]
                for enclosing in [
                    'case 1 in 1) while false; do cd sub; done;; esac',
                    'if true; then while false; do cd sub; done; fi',
                    'case 1 in 1) for j in 1; do cd sub; done;; esac',
                ]:
                    for reader in readers:
                        command = 'cd ' + shlex.quote(root) + '; ' + enclosing + '; ' + reader
                        for wrapped in [command, command.replace(reader, 'offbox run -- ' + reader),
                                        'offbox run -- ' + shlex.quote(command)]:
                            with self.subTest(command=wrapped):
                                # The existing JS reader does not recognize a
                                # bare legacy state.sqlite even at known cwd.
                                # A remote-only payload that names the live directory is refused.
                                if (name == 'state.sqlite' and reader.startswith('node -e ') and
                                        not remote_only_offbox(wrapped)):
                                    self.assertIsNone(guard.classify(wrapped, str(self.root)))
                                else:
                                    self.assertIsNotNone(guard.classify(wrapped, str(self.root)))

    def test_loop_cwd_enclosing_database_recovery(self):
        prefix = 'cd /Users/x/.robob/userdata; case 1 in 1) while false; do cd sub; done;; esac; '
        for name in ['statev2.sqlite', 'state.sqlite', 'opencode.db']:
            for recovery in ['', 'cd ' + shlex.quote(str(self.root)) + '; ']:
                operand = name if recovery else str(self.root / name)
                readers = [
                    'python3 -I -c ' + shlex.quote(f'open({operand!r}).read()'),
                    'node -e ' + shlex.quote(f'require("fs").readFileSync({operand!r})'),
                    'cat ' + shlex.quote(operand),
                    'cat < ' + shlex.quote(operand),
                    "python3 -I <<'PY'\n" + f'open({operand!r}).read()\nPY\n',
                ]
                # Bare sqlite3 state.sqlite is independently refused even at a
                # known cwd; an absolute foreign operand has its own proof.
                if not recovery or name != 'state.sqlite':
                    readers.append('sqlite3 ' + shlex.quote(operand) + ' .schema')
                for reader in readers:
                    command = prefix + recovery + reader
                    for wrapped in [command, prefix + recovery + 'offbox run -- ' + reader,
                                    'offbox run -- ' + shlex.quote(command)]:
                        with self.subTest(command=wrapped):
                            # No remote-only payload has a reason to name the live directory.
                            if remote_only_offbox(wrapped):
                                self.assertEqual(guard.classify(wrapped, str(self.root)), READ)
                            else:
                                self.assertEqual(guard.classify_detail(wrapped, str(self.root)), (None, None))

    def test_loop_cwd_enclosing_cwd_relative_readers(self):
        for root in ['/Users/x/.robob/userdata', str(Path.home() / '.t3/userdata'),
                     '/Users/x/.local/share/opencode']:
            for body in [
                'from pathlib import Path; [p.read_bytes() for p in Path(".").glob("*.sqlite")]',
                'from pathlib import Path; [p.read_bytes() for p in Path.cwd().iterdir()]',
                'from pathlib import Path; [p.read_bytes() for p in Path(".").rglob("*.sqlite*")]',
                'import os; [open(p, "rb").read() for p in os.listdir(".")]',
                'import sqlite3, glob; sqlite3.connect(next(glob.iglob("*")))',
            ]:
                reader = 'python3 -I -c ' + shlex.quote(body)
                for enclosing in [
                    'case 1 in 1) while false; do cd sub; done;; esac',
                    'if true; then while false; do cd sub; done; fi',
                ]:
                    for recovery in ['', 'cd ' + shlex.quote(str(self.root)) + '; ']:
                        prefix = 'cd ' + shlex.quote(root) + '; ' + enclosing + '; ' + recovery
                        command = prefix + reader
                        for wrapped in [command, prefix + 'offbox run -- ' + reader,
                                        'offbox run -- ' + shlex.quote(command)]:
                            with self.subTest(command=wrapped):
                                expected = READ if remote_only_offbox(wrapped) or not recovery else None
                                self.assertEqual(guard.classify(wrapped, str(self.root)), expected)

    def test_loop_cwd_enclosing_later_directory_changes(self):
        enclosing_blocks = [
            'case 1 in 1) while false; do cd sub; done;; esac',
            'if true; then while false; do cd sub; done; fi',
        ]
        for enclosing in enclosing_blocks:
            for reader in ['cat userdata/statev2.sqlite',
                           'python3 -I -c ' + shlex.quote('open("userdata/statev2.sqlite").read()')]:
                for transition in ['cd ..; ', 'env -C .. ', 'env --chdir .. ', 'env --chdir=.. ',
                                   'uv --directory .. run ', 'uv run --directory .. ']:
                    prefix = 'cd /Users/x/.robob/userdata; ' + enclosing + '; '
                    command = prefix + transition + reader
                    argv = prefix + (transition + 'offbox run -- ' + reader if transition == 'cd ..; '
                                     else 'offbox run -- ' + transition + reader)
                    for wrapped in [command, argv, 'offbox run -- ' + shlex.quote(command)]:
                        with self.subTest(command=wrapped):
                            self.assertIsNotNone(guard.classify(wrapped, str(self.root)))

    def test_loop_cwd_enclosing_directory_candidate_budget(self):
        command = 'case 1 in 1) while false; do cd sub; done;; esac; cd ..; cd ../other; true'
        with patch.object(guard, 'MAX_SCRIPTS', 2):
            rule, cause = guard.classify_detail(command, str(self.root))
        self.assertEqual(rule, UNRESOLVED)
        self.assertIn('MAX_SCRIPTS', cause)

    def test_loop_cwd_enclosing_remote_pwd_arguments(self):
        for enclosing in ['case 1 in 1) while false; do cd sub; done;; esac',
                          'if true; then while false; do cd sub; done; fi']:
            for transition, operand in [('', '$PWD/statev2.sqlite'), ('cd ..; ', '$PWD/userdata/statev2.sqlite')]:
                for reader in ['cat "' + operand + '"', 'python3 -I -c "open(\'' + operand + '\').read()"']:
                    command = 'cd /Users/x/.robob/userdata; ' + enclosing + '; ' + transition + 'offbox run -- ' + reader
                    with self.subTest(command=command):
                        self.assertIsNotNone(guard.classify(command, str(self.root)))

    def test_loop_cwd_enclosing_remote_pwd_script_proof(self):
        safe = self.write('repeat/arm.py', 'print(1)')
        self.write('repeat/sub/arm.py', 'print(1)')
        self.write('repeat/sub/sub/arm.py', 'print(1)')
        deep = self.write('repeat/sub/sub/sub/arm.py', f'open({LIVE!r}).read()')
        variable_safe = self.write('variable/arm.py', 'print(1)')
        variable_target = self.write('variable/sub/arm.py', f'open({LIVE!r}).read()')
        loop = 'for j in 1 2 3; do cd sub; done'
        cases = [
            (safe.parent, loop, deep, safe),
            (safe.parent, 'case 1 in 1) { ' + loop + '; };; esac', deep, safe),
            (safe.parent, 'if true; then { ' + loop + '; }; fi', deep, safe),
            (variable_safe.parent, 'd=sub; cd "$d"', variable_target, variable_safe),
        ]
        for cwd, prefix, target, safe_script in cases:
            with self.subTest(target=str(target)):
                self.assertEqual(guard.classify('python3 -I ' + shlex.quote(str(target)), str(cwd)), SCRIPT)
            for pwd in ['$PWD', '${PWD}']:
                script = 'python3 -I "' + pwd + '/arm.py"'
                local = prefix + '; ' + script
                argv = prefix + '; offbox run -- ' + script
                for command in [local, argv, 'offbox run -- ' + shlex.quote(local),
                                'offbox run -- ' + shlex.quote(argv)]:
                    with self.subTest(command=command):
                        self.assertEqual(guard.classify(command, str(cwd)),
                                         None if remote_only_offbox(command) else UNRESOLVED)
                absolute = prefix + '; python3 -I ' + shlex.quote(str(safe_script))
                absolute_argv = prefix + '; offbox run -- python3 -I ' + shlex.quote(str(safe_script))
                recovery = prefix + '; cd ' + shlex.quote(str(cwd)) + '; offbox run -- ' + script
                unchanged = prefix.replace('cd sub', ':').replace('cd "$d"', ':') + '; offbox run -- ' + script
                for command in [absolute, absolute_argv, 'offbox run -- ' + shlex.quote(absolute),
                                'offbox run -- ' + shlex.quote(absolute_argv), recovery,
                                'offbox run -- ' + shlex.quote(recovery), unchanged,
                                'offbox run -- ' + shlex.quote(unchanged)]:
                    with self.subTest(command=command):
                        self.assertEqual(guard.classify_detail(command, str(cwd)), (None, None))

    def test_mktemp_109_offbox_flags(self):
        setup = 'd=$(mktemp -d)\n' + self.heredoc('"$d/x.py"', 'print(1)')
        for flags in ['--git', '--fresh', '--no-sync', '--no-retry', '--template python',
                      '--template=python', '--base warm', '--base=warm', '--pull tmp/out', '--pull=tmp/out']:
            with self.subTest(flags=flags):
                self.assertEqual(self.classify(setup + 'offbox run ' + flags + ' -- python3 -I "$d/x.py"'), UNRESOLVED)
        # Environment flags can prove an on-disk fixture invocation, but
        # retain the separate caller-heredoc exception's narrower boundary.
        for flags in ['--env FOO=bar', '--env=FOO=bar', '--env PYTHONPATH=/tmp/x', '--unknown']:
            with self.subTest(flags=flags):
                self.assertEqual(self.classify(setup + 'offbox run ' + flags + ' -- python3 "$d/x.py"'), UNRESOLVED)
                self.assertEqual(self.classify('offbox run ' + flags + ' -- python3 tmp/live.py'), SCRIPT)
        for flags in ['--pull tmp/out', '--pull=tmp/out']:
            command = setup + 'offbox run ' + flags + ' -- true; python3 "$d/x.py"'
            rule, cause = guard.classify_detail(command, str(self.root))
            self.assertEqual(rule, UNRESOLVED)
            self.assertIn('offbox --pull at line', cause)

    def test_mktemp_109_unsafe_matrix(self):
        script = self.heredoc('"$d/x.py"', 'print(1)')
        rows = [
            ('d=$(mktemp -d); ' + script, 'python3 $d/x.py', 'unquoted'),
            ('[ -n "$OTHER" ] && d=$(mktemp -d); ' + script, 'python3 "$d/x.py"', 'conditional'),
            ('d=$(mktemp -d); d=$OTHER; ' + script, 'python3 "$d/x.py"', 'reassigned'),
            ('d=$(mktemp -d); cp /source/x.py "$d/x.py"; ', 'python3 "$d/x.py"', 'copy'),
            ('d=$(mktemp -d); printf "%s" "$BODY" > "$d/x.py"; ', 'python3 "$d/x.py"', 'non-heredoc'),
            ('d=$(mktemp -d); curl -o "$d/x.py" https://example.test/x; ', 'python3 "$d/x.py"', 'invalidated'),
            ('d=$(mktemp -d); python3 -c \'open("out", "w").write("x")\'; ', 'python3 "$d/x.py"', 'no readable'),
            ('d=$(mktemp -d); python3 -c \'import sys; open(sys.argv[1], "w").write("x")\' "$d/x.py"; ', 'python3 "$d/x.py"', 'invalidated'),
            ('d=$(mktemp -d); ' + script + 'echo hi > "$d/x.py"\n', 'python3 "$d/x.py"', 'non-heredoc'),
            ('d=$(mktemp -d); ' + script + 'echo hi > $d/other\n', 'python3 "$d/x.py"', 'unquoted'),
            ('d=$(mktemp -d); ' + script + 'echo hi > "$UNKNOWN/other"\n', 'python3 "$d/x.py"', 'unbounded'),
        ]
        for setup, runner, reason in rows:
            for wrapper in ['', 'offbox run -- ']:
                command = setup + wrapper + runner
                with self.subTest(command=command):
                    rule, cause = guard.classify_detail(command, str(self.root))
                    self.assertEqual(rule, UNRESOLVED)
                    self.assertIn('Accepted:', cause)
                    self.assertIn(reason, cause)
        for wrapper in ['', 'offbox run -- ']:
            rule, cause = guard.classify_detail('d=$(mktemp -d); ' + wrapper + 'bash "$d/x.sh"', str(self.root))
            self.assertEqual(rule, UNRESOLVED)
            self.assertIn('no readable same-call heredoc writer', cause)
        for wrapper in ['', 'offbox run -- ']:
            for live in [LIVE, str(Path.home() / '.t3/userdata/state.sqlite'), '/Users/x/.local/share/opencode/opencode.db']:
                command = 'd=$(mktemp -d); ' + self.heredoc('"$d/x.py"', f'open({live!r}).read()') + wrapper + 'python3 "$d/x.py"'
                self.assertIsNotNone(self.classify(command))
                command = 'd=$(mktemp -d); cp ' + live + ' "$d/data"; ' + script + wrapper + 'python3 "$d/x.py"'
                self.assertIsNotNone(self.classify(command))

    def test_mktemp_109_single_string_payload_scope(self):
        prefix = 'd=$(mktemp -d)\n' + self.heredoc('"$d/x.py"', 'print(1)')
        # A literal $ keeps these payloads on the box, so their scratch
        # scripts never run on the Mac (#221); a caller-expanded $d may.
        self.assertIsNone(self.classify(prefix + 'offbox run -- \'python3 "$d/x.py"\''))
        self.assertEqual(self.classify(prefix + 'offbox run -- python3 "$d/x.py"'), UNRESOLVED)
        for cd in ['', 'cd tmp\n']:
            for body in ['print(1)', f'open({LIVE!r}).read()']:
                payload = 'd=$(mktemp -d)\n' + cd + self.heredoc('"$d/x.py"', body) + 'python3 "$d/x.py"'
                result = guard.classify_detail('offbox run -- ' + shlex.quote(payload), str(self.root))
                # A live path spelled in the payload text is still refused.
                self.assertEqual(result[0], READ if 'open(' in body else None, result)

    def test_mktemp_109_bun_preload_and_messages(self):
        for flag in ['--preload "$d/clock.ts"', '--preload="$d/clock.ts"']:
            for body, expected in [('console.log(1)', UNRESOLVED), (f'require("fs").readFileSync({LIVE!r})', SCRIPT)]:
                command = 'd=$(mktemp -d)\n' + self.heredoc('"$d/clock.ts"', body) + 'bun test ' + flag + ' tmp/test.ts'
                self.assertEqual(self.classify(command), expected, command)
        for binary in ['python3', 'node', 'bash', 'bun']:
            command = 'd=$(mktemp -d)\nprintf hi > "$d/x.py"\n' + binary + ' "$d/x.py"'
            rule, cause = guard.classify_detail(command, str(self.root))
            reason = guard.refusal_reason(rule, cause, str(self.root))
            for text in ['non-heredoc writer (printf) at line 2', 'Accepted:', binary, 'literal absolute script path']:
                self.assertIn(text, reason)
            self.assertEqual(reason.count('Accepted:'), 1)
        for command in ['python3 tmp/live.py', 'vp run migrate-dev-db']:
            rule, cause = guard.classify_detail(command, str(self.root))
            self.assertNotIn('Accepted:', guard.refusal_reason(rule, cause, str(self.root)))

    def test_mktemp_109_runtime_file_operands(self):
        runners = [('bun test', '--preload'), ('bun', '--preload')]
        runners += [('node', flag) for flag in sorted(guard.NODE_SCRIPT_OPTIONS)]
        for runner, flag in runners:
            for separator in [' ', '=']:
                for wrapper in ['', 'offbox run -- ', 'offbox run --include "$d" -- ']:
                    for quoted in [True, False]:
                        operand = '"$d/hook.js"' if quoted else '$d/hook.js'
                        for body, expected in [('console.log(1)', UNRESOLVED),
                                               (f'require("fs").readFileSync({LIVE!r})', SCRIPT if quoted else UNRESOLVED)]:
                            command = 'd=$(mktemp -d)\n' + self.heredoc('"$d/hook.js"', body)
                            command += wrapper + runner + ' ' + flag + separator + operand + ' tmp/main.js'
                            with self.subTest(command=command):
                                self.assertEqual(self.classify(command), expected)

    def test_mktemp_109_path_marker(self):
        marker = self.write('tmp/scratch-path.txt', str(self.root / 'tmp/marker-root'))
        (self.root / 'tmp/marker-root').mkdir()
        setup = f'd=$(cat {marker})\n' + self.heredoc('"$d/x.py"', 'print(1)')
        self.assertIsNone(self.classify(setup + 'python3 -I "$d/x.py"'))
        for value in [str(self.root / 'tmp/marker-root') + '\n', '/tmp/a\n/tmp/b', '$OTHER', '/tmp/a*', '~/x', LIVE, '/Users/x/.robob/userdata', '/tmp/$(echo x)']:
            marker.write_text(value)
            rule, cause = guard.classify_detail(setup + 'python3 "$d/x.py"', str(self.root))
            self.assertEqual(rule, UNRESOLVED, value)
            self.assertIn('read the path first, then use it literally', cause)
        marker.write_text(str(self.root / 'tmp/marker-root'))
        for mutation in [f'echo /tmp/other > {marker}\n', f'echo /tmp/other > {marker}; ', f'cp /other/file {marker}\n']:
            for command in [mutation + setup + 'python3 "$d/x.py"', setup + mutation + 'python3 "$d/x.py"']:
                self.assertEqual(self.classify(command), UNRESOLVED)
        for wrapper in ['', 'offbox run -- ']:
            self.assertEqual(self.classify(setup + wrapper + 'python3 $d/x.py'), UNRESOLVED)
            self.assertEqual(self.classify(setup + wrapper + 'python3 -I "$d/x.py"'), UNRESOLVED if wrapper else None)
        for mutation in [f'm={marker}; echo /tmp/other > "$m"; ',
                         f'python3 -c \'open("{marker}", "w").write("/tmp/other")\'; ',
                         'python3 tmp/unknown-writer.py; ']:
            self.assertEqual(self.classify(mutation + setup + 'python3 "$d/x.py"'), UNRESOLVED)
        for target in ['"$PWD/tmp/scratch-path.txt"', '"${PWD}/tmp/scratch-path.txt"',
                       '"$PWD"/tmp/scratch-path.txt', '"${PWD}"/tmp/scratch-path.txt']:
            for wrapper in ['', 'offbox run -- ']:
                command = f'printf %s {LIVE} > {target}; d=$(cat {marker}); ' + wrapper + 'python3 "$d"'
                rule, cause = guard.classify_detail(command, str(self.root))
                self.assertEqual(rule, UNRESOLVED)
                self.assertIn('read the path first, then use it literally', cause)
        command = f'cd tmp; printf %s {LIVE} > scratch-path.txt; cd ..; d=$(cat {marker}); python3 "$d"'
        self.assertEqual(self.classify(command), UNRESOLVED)
        alias = self.root / 'tmp/marker-alias'
        alias.symlink_to(marker)
        for writer in [f'printf %s {LIVE} > {alias}; ', f'm={alias}; printf %s {LIVE} > "$m"; ']:
            command = writer + f'd=$(cat {marker}); python3 "$d"'
            rule, cause = guard.classify_detail(command, str(self.root))
            self.assertEqual(rule, UNRESOLVED)
            self.assertIn('read the path first, then use it literally', cause)
        hard = self.root / 'tmp/marker-hardlink'
        os.link(marker, hard)
        for reader in [marker, hard]:
            for wrapper in ['', 'offbox run -- ']:
                for before in [True, False]:
                    writer = f'printf %s /Users/x/.robob/userdata > {hard}; '
                    binding = f'd=$(cat {reader}); '
                    command = (writer + binding if before else binding + writer) + wrapper + 'python3 "$d/statev2.sqlite"'
                    rule, cause = guard.classify_detail(command, str(self.root))
                    self.assertEqual(rule, UNRESOLVED)
                    self.assertIn('read the path first, then use it literally', cause)

    def test_same_call_review_writer_forms(self):
        bodies = {
            'import alias': "from os import rename as f\nf('unchecked.py', 'tmp/x.py')",
            'dynamic callable': "import operator\nf=operator.methodcaller('write_text', 'print(2)')\nf(target)",
            'conditional binding': "from pathlib import Path\np=Path('tmp/x.py')\nif False:\n p=Path('tmp/data')\np.write_text('print(2)')",
            'annotated binding': "from pathlib import Path\np=Path('tmp/data')\np: object=Path('tmp/x.py')\np.write_text('print(2)')",
            'parameter shadow': "from pathlib import Path\np=Path('tmp/data')\ndef edit(p):\n p.write_text('print(2)')\nedit(Path('tmp/x.py'))",
            'annotated alias': "writer: object = open\nwriter(__file__, 'w').write('print(2)')",
            'walrus alias': "(writer := open)(__file__, 'w').write('print(2)')",
            'unpacked alias': "writer, = [open]\nwriter(__file__, 'w').write('print(2)')",
            'chained alias': "writer = other = open\nwriter(__file__, 'w').write('print(2)')",
            'dunder alias': "from io import open as writer\nwriter.__call__(__file__, 'w').write('print(2)')",
        }
        for label, body in bodies.items():
            command = self.heredoc('tmp/x.py', body) + 'python3 -I tmp/x.py\npython3 -I tmp/x.py'
            with self.subTest(label=label):
                self.assertEqual(self.classify(command), UNRESOLVED)
        bodies = [
            "const trim=process.getBuiltinModule; const split=trim('fs').copyFileSync; split(process.argv[2],process.argv[1]);",
            "readFileSync = process.dlopen; readFileSync(process.argv[2]);",
        ]
        for body in bodies:
            command = 'd=$(mktemp -d); ' + self.heredoc('"$d/x.js"', body) + 'node "$d/x.js" unchecked.js\nnode "$d/x.js"'
            self.assertEqual(self.classify(command), UNRESOLVED)
        seed = self.write('tmp/seed.ndjson', 'print(2)')
        seed.chmod(0o444)
        for variable in ['$d', '${d}']:
            for name in ['seed.ndjson', './seed.ndjson', 'nested/../seed.ndjson', 'sibling.py']:
                target = '"' + variable + '/' + name + '"'
                prefix = 'd=$(mktemp -d); cp ' + str(seed) + ' "' + variable + '/"; '
                command = prefix + self.heredoc(target, 'print(1)') + 'python3 -I ' + target
                with self.subTest(variable=variable, name=name):
                    self.assertEqual(self.classify(command), UNRESOLVED)
        command = 'd=$(mktemp -d /Users/x/.robob/userdata/scratch.XXXXXX); ' + self.heredoc('"$d/report.py"', 'print(1)') + 'python3 -I "$d/report.py"'
        self.assertEqual(self.classify(command), UNRESOLVED)
        for relative, runner in [
            ('integrations/robob-watch/checks/money-cases/test_order_charges.py', 'python3 -m unittest discover -s integrations/robob-watch/checks/money-cases'),
            ('integrations/memory-system/tests/test_state_lineage_logging.py', 'python3 -m unittest discover -s integrations/memory-system/tests'),
            ('integrations/memory-system/tests/benchmark_recall_storage.py', 'offbox run -- python3 integrations/memory-system/tests/benchmark_recall_storage.py'),
        ]:
            command = self.heredoc(relative, 'import sqlite3; sqlite3.connect(' + repr(LIVE) + ')') + runner
            self.assertEqual(self.classify(command), SCRIPT)

    def classify(self, command):
        return guard.classify(command, str(self.root))

    def table(self, rows):
        for command, expected in rows:
            with self.subTest(command=command):
                self.assertEqual(self.classify(command), expected)

    def test_flighty_notify_foreign_database(self):
        fixture = Path(__file__).with_name('fixtures') / 'flighty_notify.sh'
        command = f'{shlex.quote(str(fixture))} owner "EK366@2026-11-16:belt-7" "test"'
        rule, cause = guard.classify_detail(command, str(self.root))
        self.assertEqual(rule, UNRESOLVED)
        self.assertIn('zsh: implicit startup unproved', cause)
        self.adapters(command, UNRESOLVED)

    def test_foreign_state_sqlite_paths(self):
        paths = [
            '~/.config/spectrum-bridge/state.sqlite',
            '$HOME/.config/telegram-bridge/state.sqlite',
            '${HOME}/.config/telegram-bridge/state.sqlite',
            '/Users/ardud/.local/share/example-tool/state.sqlite',
        ]
        for path in paths:
            shell = f'CLI=/Users/ardud/.local/share/spectrum-bridge/src/cli.ts\nsqlite3 -readonly "{path}" "select 1"\n'
            python = f'import os, sqlite3\nsqlite3.connect(os.path.expanduser({path!r}))\n'
            node = f'import {{ DatabaseSync }} from "node:sqlite";\nconst cli = "/Users/ardud/.local/share/tool/cli.ts";\nnew DatabaseSync("{path}");\n'
            for extension, runner, source in [('sh', 'zsh', shell), ('py', 'python3 -I', python), ('mjs', 'node', node)]:
                with self.subTest(path=path, extension=extension):
                    script = self.write('tmp/foreign.' + extension, source)
                    self.assertEqual(self.classify(f'{runner} {shlex.quote(str(script))} owner'), None)
            self.assertEqual(self.classify(f'sqlite3 -readonly "{path}" "select 1"'), None)

    def test_foreign_state_sqlite_does_not_hide_live_database(self):
        paths = [
            '~/.robob/userdata/statev2.sqlite',
            '~/.robob/userdata/state.sqlite',
            '~/.robob/userdata/nested/state.sqlite',
            '~/.t3/userdata/statev2.sqlite',
            '~/.t3/userdata/state.sqlite',
            '~/.local/share/opencode/opencode.db',
        ]
        fixture = (Path(__file__).with_name('fixtures') / 'flighty_notify.sh').read_text()
        for path in paths:
            shell = fixture.replace('~/.config/spectrum-bridge/state.sqlite', path)
            python = f'import os, sqlite3\nsqlite3.connect(os.path.expanduser({path!r}))\n'
            node = f'import {{ DatabaseSync }} from "node:sqlite";\nnew DatabaseSync("{path}");\n'
            for extension, runner, source in [('sh', 'zsh', shell), ('py', 'python3 -I', python), ('mjs', 'node', node)]:
                with self.subTest(path=path, extension=extension):
                    script = self.write('tmp/protected.' + extension, source)
                    self.assertEqual(self.classify(f'{runner} {shlex.quote(str(script))} owner'), SCRIPT)
            with self.subTest(path=path, entry='sqlite3'):
                self.assertEqual(self.classify(f'sqlite3 -readonly "{path}" "select 1"'), READ)

    def test_unresolved_state_sqlite_directory(self):
        for path in ['state.sqlite', '$D/state.sqlite', '${D}/state.sqlite', '~/$D/state.sqlite', '~/*/state.sqlite', '$(pwd)/state.sqlite']:
            command = f'sqlite3 -readonly "{path}" "select 1"'
            with self.subTest(path=path):
                self.assertEqual(self.classify(command), READ)
                script = self.write('tmp/unknown.sh', 'CLI=/Users/ardud/.local/share/tool/cli.ts\n' + command)
                self.assertEqual(self.classify('zsh ' + shlex.quote(str(script))), SCRIPT)
        for directory in ['~/.robob/userdata', '~/.t3/userdata']:
            with self.subTest(directory=directory):
                self.assertEqual(self.classify(f'cd {directory} && sqlite3 state.sqlite "select 1"'), READ)

    def test_foreign_state_sqlite_keeps_other_live_references(self):
        foreign = '/Users/ardud/.config/spectrum-bridge/state.sqlite'
        for other in ['statev2.sqlite', 'statev2.pre-shrink.sqlite', 'opencode.db', 'state.sqlite']:
            with self.subTest(other=other):
                source = f'const foreign = "{foreign}";\nconst root = process.env.HOME + "/.robob/userdata";\nnew Database(root + "/{other}");\n'
                script = self.write('tmp/mixed.mjs', source)
                self.assertEqual(self.classify('node ' + shlex.quote(str(script))), SCRIPT)
        for expression in ['foreign.replace(".config/spectrum-bridge", ".robob/userdata")',
                           'path.join(process.env.HOME, ".robob", "userdata", path.basename(foreign))',
                           'path.join(process.env.T3CODE_HOME, "userdata", path.basename(foreign))',
                           'path.join(os.homedir(), "userdata", path.basename(foreign))']:
            with self.subTest(expression=expression):
                source = f'const foreign = "{foreign}";\nnew Database({expression});\n'
                script = self.write('tmp/transformed.mjs', source)
                self.assertEqual(self.classify('node ' + shlex.quote(str(script))), SCRIPT)

    def test_foreign_state_sqlite_preserves_root_evidence(self):
        imports = 'import { DatabaseSync } from "node:sqlite";\nimport path from "node:path";\n'
        rows = [
            ('opencode sibling', '/Users/ardud/.local/share/opencode/state.sqlite',
             'path.join(path.dirname(foreign), "opencode.db")'),
            ('robob sibling', '/Users/ardud/.robob/other/state.sqlite',
             'path.join(path.dirname(path.dirname(foreign)), "userdata", "statev2.sqlite")'),
        ]
        for label, foreign, expression in rows:
            with self.subTest(case=label):
                source = imports + f'const foreign = "{foreign}";\nnew DatabaseSync({expression});\n'
                script = self.write('tmp/sibling.mjs', source)
                command = 'node ' + shlex.quote(str(script))
                self.assertEqual(self.classify(command), SCRIPT)
                self.adapters(command, SCRIPT)
                self.assertEqual(self.classify("node - <<'JS'\n" + source + 'JS'), READ)
        source = ('foreign=~/.config/spectrum-bridge/state.sqlite\n'
                  'sqlite3 -readonly ~/.robob/userdata/state.sqlite "select 1"\n')
        script = self.write('tmp/plain-live-operand.sh', source)
        command = 'zsh ' + shlex.quote(str(script)) + ' owner'
        self.assertEqual(self.classify(command), SCRIPT)
        self.adapters(command, SCRIPT)
        self.assertEqual(self.classify("zsh -s <<'BODY'\n" + source + 'BODY'), READ)
        for foreign in ['/Users/ardud/.local/share/tool/state.sqlite', '~/.local/share/tool/state.sqlite',
                        '$HOME/.local/share/tool/state.sqlite', '${HOME}/.local/share/tool/state.sqlite']:
            for name in ['statev2.sqlite', 'opencode.db', 'state.sqlite']:
                node = imports + f'const foreign = "{foreign}";\nconst name = "{name}";\nnew DatabaseSync(path.join(process.env.D, name));\n'
                shell = f'foreign="{foreign}"\nsqlite3 "$D/{name}" "select 1"\n'
                for extension, runner, source in [('mjs', 'node', node), ('sh', 'zsh', shell)]:
                    with self.subTest(foreign=foreign, name=name, extension=extension):
                        script = self.write('tmp/variable-operand.' + extension, source)
                        self.assertEqual(self.classify(runner + ' ' + shlex.quote(str(script)) + ' owner'), SCRIPT)
                        if extension == 'mjs':
                            self.assertEqual(self.classify("node - <<'BODY'\n" + source + 'BODY'), READ)

    def test_foreign_state_sqlite_basename_reuse(self):
        foreign = '/Users/ardud/.robob/other/state.sqlite'
        imports = 'import { DatabaseSync } from "node:sqlite";\nimport path from "node:path";\n'
        for expression in [
            'path.join(path.dirname(path.dirname(foreign)), "userdata", path.basename(foreign))',
            'path.join(process.env.D, path.basename(foreign))',
            'path.join(process.env.D, foreign.split("/").pop())',
            'foreign.replace("/other/", "/userdata/")',
            json.dumps(foreign) + '.replace("/other/", "/userdata/")',
        ]:
            with self.subTest(language='node', expression=expression):
                source = imports + f'const foreign = "{foreign}";\nnew DatabaseSync({expression});\n'
                script = self.write('tmp/basename.mjs', source)
                command = 'node ' + shlex.quote(str(script))
                self.assertEqual(self.classify(command), SCRIPT)
                self.adapters(command, SCRIPT)
                stdin = "node - <<'JS'\n" + source + 'JS'
                self.assertEqual(self.classify(stdin), READ)
                self.adapters(stdin, READ)
        for target in [
            '"$(dirname "$(dirname "$foreign")")/userdata/$(basename "$foreign")"',
            '"$D/$(basename "$foreign")"',
        ]:
            source = f'foreign="{foreign}"\nsqlite3 -readonly {target} "select 1"\n'
            script = self.write('tmp/basename.sh', source)
            for runner in ['bash', 'zsh']:
                with self.subTest(language='shell', runner=runner, target=target):
                    command = runner + ' ' + shlex.quote(str(script)) + ' owner'
                    self.assertEqual(self.classify(command), SCRIPT)
                    self.adapters(command, SCRIPT)

    def test_foreign_state_sqlite_direct_reader_operands(self):
        for path, expected in [('/Users/ardud/.robob/other/state.sqlite', SCRIPT),
                               ('/Users/ardud/.local/share/opencode/state.sqlite', SCRIPT),
                               ('~/.config/spectrum-bridge/state.sqlite', None),
                               ('$HOME/.config/tool/state.sqlite', None),
                               ('${HOME}/state.sqlite', None), ('/state.sqlite', None)]:
            imports = 'import { DatabaseSync } from "node:sqlite";\nimport fs from "node:fs";\n'
            for reader in ['new DatabaseSync', 'fs.readFileSync']:
                with self.subTest(path=path, reader=reader):
                    source = imports + f'{reader}({json.dumps(path)});\n'
                    script = self.write('tmp/direct-foreign.mjs', source)
                    self.assertEqual(self.classify('node ' + shlex.quote(str(script))), expected)
                    self.assertEqual(self.classify("node - <<'JS'\n" + source + 'JS'), READ if expected else None)
            for operand in [path, '"' + path + '"']:
                with self.subTest(path=path, operand=operand):
                    command = 'sqlite3 -readonly ' + operand + ' "select 1"'
                    self.assertIsNone(self.classify(command))
                    script = self.write('tmp/direct-foreign.sh', command)
                    self.assertEqual(self.classify('zsh ' + shlex.quote(str(script)) + ' owner'), expected)
        source = ("import os, sqlite3\n"
                  "sqlite3.connect(os.path.expanduser('~/.config/spectrum-bridge/state.sqlite'))\n")
        script = self.write('tmp/direct-foreign.py', source)
        command = 'python3 -I ' + shlex.quote(str(script))
        self.assertIsNone(self.classify(command))
        self.adapters(command)
        stdin = "python3 -I - <<'PY'\n" + source + 'PY'
        self.assertIsNone(self.classify(stdin))
        self.adapters(stdin)

    def test_foreign_state_sqlite_round_three_findings(self):
        rows = [
            ('open wrapper', 'mjs', 'node', 'node -',
             "import { DatabaseSync } from 'node:sqlite';\n"
             "function open(file) { return new DatabaseSync(file.replace('/other/', '/userdata/')); }\n"
             "open('/Users/ardud/.robob/other/state.sqlite');\n"),
            ('sqlite3 wrapper', 'sh', 'bash', 'bash -s',
             'sqlite3() { command /usr/bin/sqlite3 "${1/other/userdata}"; }\n'
             "sqlite3 '/Users/ardud/.robob/other/state.sqlite'\n"),
            ('Bun filename reuse', 'mjs', 'bun', 'bun -',
             "import { Database } from 'bun:sqlite';\nimport path from 'node:path';\n"
             "const foreign = new Database('/Users/ardud/.robob/other/state.sqlite');\n"
             "new Database(path.join(path.dirname(path.dirname(foreign.filename)), 'userdata', path.basename(foreign.filename)));\n"),
        ]
        for label, extension, runner, stdin_runner, source in rows:
            with self.subTest(case=label):
                script = self.write('tmp/round-three.' + extension, source)
                command = runner + ' ' + shlex.quote(str(script)) + ' owner'
                self.assertEqual(self.classify(command), SCRIPT)
                self.adapters(command, SCRIPT)
                stdin = stdin_runner + " <<'BODY'\n" + source + 'BODY'
                self.assertEqual(self.classify(stdin), READ)
                self.adapters(stdin, READ)

    def test_foreign_state_sqlite_shadowed_readers(self):
        path = '~/.config/spectrum-bridge/state.sqlite'
        rows = [
            ('function', 'mjs', 'node', 'node -', 'function open(f) { return f; }'),
            ('const', 'mjs', 'node', 'node -', 'const open = f => f;'),
            ('let', 'mjs', 'node', 'node -', 'let open = f => f;'),
            ('var', 'mjs', 'node', 'node -', 'var open = f => f;'),
            ('assignment', 'mjs', 'node', 'node -', 'open = f => f;'),
            ('destructure', 'mjs', 'node', 'node -', 'const { open } = helpers;'),
            ('import-as', 'mjs', 'node', 'node -', "import { helper as open } from './helper.js';"),
            ('import-default', 'mjs', 'node', 'node -', "import open from './helper.js';"),
            ('parameter', 'mjs', 'node', 'node -', 'function wrapper(open) { return open; }'),
            ('def', 'py', 'python3 -I', 'python3 -I -', 'def open(f):\n    return f'),
            ('python import-as', 'py', 'python3 -I', 'python3 -I -', 'from helpers import helper as open'),
            ('shell function', 'sh', 'bash', 'bash -s', 'sqlite3() { cat "$1"; }'),
            ('alias', 'sh', 'bash', 'bash -s', "alias sqlite3='cat'"),
        ]
        for label, extension, runner, stdin_runner, declaration in rows:
            call = 'sqlite3 "' + path + '"' if extension == 'sh' else 'open(' + repr(path) + ')'
            source = declaration + '\n' + call + '\n'
            with self.subTest(case=label):
                self.assertIsNone(guard.PROTECTED_SOURCE_TOKEN.search(source))
                script = self.write('tmp/shadowed.' + extension, source)
                command = runner + ' ' + shlex.quote(str(script)) + ' owner'
                self.assertEqual(self.classify(command), SCRIPT)
                self.adapters(command, SCRIPT)
                stdin = stdin_runner + " <<'BODY'\n" + source + 'BODY'
                self.assertEqual(self.classify(stdin), READ)
                self.adapters(stdin, READ)

        for name in ['Database', 'DatabaseSync', 'connect', 'readFileSync']:
            source = f'function {name}(f) {{ return f; }}\n{name}({path!r});\n'
            with self.subTest(reader=name):
                script = self.write('tmp/shadowed-reader.mjs', source)
                command = 'node ' + shlex.quote(str(script))
                self.assertEqual(self.classify(command), SCRIPT)
                self.adapters(command, SCRIPT)
                stdin = "node - <<'JS'\n" + source + 'JS'
                self.assertEqual(self.classify(stdin), READ)
                self.adapters(stdin, READ)

    def test_foreign_state_sqlite_protected_source_gate(self):
        for token in ['.robob', '.t3', 'robob-data', 'userdata', 'opencode']:
            for text in [token, token.upper()]:
                source = ('import { DatabaseSync } from "node:sqlite";\n'
                          'const cli = "/Users/ardud/.local/share/tool/cli.ts";\n'
                          f'// prefix-{text}-suffix\n'
                          'new DatabaseSync("~/.config/spectrum-bridge/state.sqlite");\n')
                with self.subTest(token=text):
                    script = self.write('tmp/protected-token.mjs', source)
                    self.assertEqual(self.classify('node ' + shlex.quote(str(script))), SCRIPT)
                    self.assertEqual(self.classify("node - <<'JS'\n" + source + 'JS'), READ)

    def test_flighty_notify_exact_owner_command(self):
        fixture = Path(__file__).with_name('fixtures') / 'flighty_notify.sh'
        self.assertIsNone(guard.PROTECTED_SOURCE_TOKEN.search(fixture.read_text()))
        standin = self.write('opencode/skills/flighty/scripts/flighty_notify.sh', fixture.read_text())
        owner_path = Path.home() / '.config/opencode/skills/flighty/scripts/flighty_notify.sh'
        realpath = os.path.realpath
        def fixture_path(path, *args, **kwargs):
            if os.path.abspath(path) == str(owner_path):
                return str(standin)
            return realpath(path, *args, **kwargs)
        command = '~/.config/opencode/skills/flighty/scripts/flighty_notify.sh owner "EK366@2026-11-16:belt-7" "test"'
        with patch.object(os.path, 'realpath', side_effect=fixture_path):
            rule, cause = guard.classify_detail(command, str(self.root))
            self.assertEqual(rule, UNRESOLVED)
            self.assertIn('zsh: implicit startup unproved', cause)
            self.adapters(command, UNRESOLVED)

    def test_foreign_state_sqlite_python_import_variants(self):
        imports = [
            ('import sqlite3; import os', 'sqlite3.connect'),
            ('import sqlite3 as sql; import os', 'sql.connect'),
            ('import os, sqlite3', 'sqlite3.connect'),
            ('import sqlite3, os', 'sqlite3.connect'),
            ('import os, sqlite3 as sql', 'sql.connect'),
            ('import sqlite3 as sql, os', 'sql.connect'),
            ('from sqlite3 import connect; import os', 'connect'),
            ('from sqlite3 import connect as db_connect; import os', 'db_connect'),
            ('from sqlite3 import (connect as db_connect, Connection); import os', 'db_connect'),
            ('from sqlite3 import *; import os', 'connect'),
            ('import sqlite3 as open; import os', 'open.connect'),
            ('from sqlite3 import connect as open; import os', 'open'),
            ('import sqlite3.dbapi2 as sql; import os', 'sql.connect'),
            ('from sqlite3.dbapi2 import connect; import os', 'connect'),
        ]
        paths = [
            ('~/.config/spectrum-bridge/state.sqlite', None),
            ('~/.robob/userdata/readonly/state.sqlite', None),
            ('~/.robob/userdata/state.sqlite', SCRIPT),
            ('~/.robob/userdata/statev2.sqlite', SCRIPT),
            ('~/.t3/userdata/state.sqlite', SCRIPT),
            ('~/.t3/userdata/statev2.sqlite', SCRIPT),
            ('~/.local/share/opencode/opencode.db', SCRIPT),
        ]
        for declaration, connect in imports:
            for path, expected in paths:
                # These imports do not establish the replica's reader proof.
                if path == '~/.robob/userdata/readonly/state.sqlite' and declaration in {
                    'from sqlite3 import *; import os',
                    'import sqlite3.dbapi2 as sql; import os',
                    'from sqlite3.dbapi2 import connect; import os',
                }:
                    expected = SCRIPT
                with self.subTest(declaration=declaration, path=path):
                    source = declaration + f'\n{connect}(os.path.expanduser({path!r}))\n'
                    script = self.write('tmp/python-imports.py', source)
                    command = 'python3 -I ' + shlex.quote(str(script))
                    self.assertEqual(self.classify(command), expected)
                    self.adapters(command, expected)
                    stdin = "python3 -I - <<'PY'\n" + source + 'PY'
                    inline_expected = READ if expected else None
                    self.assertEqual(self.classify(stdin), inline_expected)
                    self.adapters(stdin, inline_expected)

    def test_foreign_state_sqlite_python_reader_overrides(self):
        for declaration, mutation, connect in [
            ('import sqlite3', 'sqlite3 = helper', 'sqlite3.connect'),
            ('import sqlite3 as sql', 'sql = helper', 'sql.connect'),
            ('from sqlite3 import connect', 'connect = helper', 'connect'),
            ('from sqlite3 import connect as db_connect', 'db_connect = helper', 'db_connect'),
            ('import sqlite3', 'sqlite3.connect = helper', 'sqlite3.connect'),
            ('import sqlite3 as sql', 'sql.connect = helper', 'sql.connect'),
            ('import sqlite3 as sql', "setattr(sql, 'connect', helper)", 'sql.connect'),
            ('import sqlite3 as sql', "sql.__dict__['connect'] = helper", 'sql.connect'),
            ('from sqlite3 import connect as db_connect', 'def db_connect(f):\n    return f', 'db_connect'),
            ('import sqlite3 as sql', 'import helpers as sql', 'sql.connect'),
            ('from sqlite3 import connect as db_connect', 'from helpers import helper as db_connect', 'db_connect'),
            ('from .sqlite3 import connect', '', 'connect'),
        ]:
            with self.subTest(declaration=declaration, mutation=mutation):
                source = (declaration + '\nimport os\n' + mutation + '\n' +
                          connect + "(os.path.expanduser('~/.config/spectrum-bridge/state.sqlite'))\n")
                script = self.write('tmp/python-override.py', source)
                command = 'python3 -I ' + shlex.quote(str(script))
                self.assertEqual(self.classify(command), SCRIPT)
                self.adapters(command, SCRIPT)
                stdin = "python3 -I - <<'PY'\n" + source + 'PY'
                self.assertEqual(self.classify(stdin), READ)
                self.adapters(stdin, READ)

    def test_readonly_replica_scripts_and_live_near_misses(self):
        rows = [
            (".robob/userdata/readonly/state.sqlite", None),
            (".robob/userdata/readonly/state.sqlite-wal", None),
            (".robob/userdata/readonly/state.sqlite-shm", None),
            (".robob/userdata/readonly/opencode.sqlite", None),
            (".robob/userdata/statev2.sqlite", SCRIPT),
            (".robob/userdata/statev2.sqlite-wal", SCRIPT),
            (".robob/userdata/statev2.sqlite-shm", SCRIPT),
            (".robob/userdata/statev2.sqlite-journal", SCRIPT),
            ("/Volumes/ExternalSSD/robob-data/userdata/statev2.sqlite", SCRIPT),
            (".robob/userdata/state.sqlite", SCRIPT),
            (".local/share/opencode/opencode.db", SCRIPT),
            (".t3/userdata/statev2.sqlite", SCRIPT),
            (".robob/userdata/readonly-x/state.sqlite", SCRIPT),
            (".robob/userdata/readonly/../state.sqlite", SCRIPT),
            (".robob/userdata/readonly/state.sqlite/../state.sqlite", SCRIPT),
            (".robob/userdata/readonly/state.sqlite-journal", SCRIPT),
            (".robob/userdata/readonly/state.sqlite.bak", SCRIPT),
        ]
        for relative, expected in rows:
            python = ("from pathlib import Path\nimport sqlite3\n"
                      f"path = Path.home() / {relative!r}\n"
                      "sqlite3.connect(f'file:{path}?mode=ro', uri=True)\n")
            node = ('import * as NodeOS from "node:os";\n'
                    'import * as NodePath from "node:path";\n'
                    'import * as NodeSqlite from "node:sqlite";\n'
                    f'const path = NodePath.join(NodeOS.homedir(), "{relative}");\n'
                    'new NodeSqlite.DatabaseSync(path, { readOnly: true });\n')
            shell_path = relative if relative.startswith('/') else '~/' + relative
            shell = f"sqlite3 -readonly {shell_path} 'select 1'\n"
            for extension, interpreter, stdin_flags, source in [
                ('py', 'python3 -I', '-', python),
                ('ts', 'node', '--input-type=module', node),
                ('mjs', 'node', '--input-type=module', node),
                ('sh', 'bash', '', shell),
            ]:
                with self.subTest(path=relative, extension=extension):
                    script = self.write('tmp/replica-probe.' + extension, source)
                    self.assertEqual(self.classify(f'{interpreter} {shlex.quote(str(script))} --thread-id x'), expected)
                    inline = f"{interpreter} {stdin_flags} <<'PROBE'\n{source}PROBE\n"
                    self.assertEqual(self.classify(inline), READ if expected else None)
            with self.subTest(path=relative, entry='sqlite3'):
                self.assertEqual(self.classify(shell), READ if expected else None)

    def test_readonly_replica_python_split_path_parts(self):
        for parts, expected in [
            (['.robob', 'userdata', 'readonly', 'state.sqlite'], None),
            (['.robob', 'userdata', 'state.sqlite'], SCRIPT),
            (['.robob', 'userdata', 'readonly', '..', 'state.sqlite'], SCRIPT),
            (['.robob', 'userdata', 'readonly-x', 'state.sqlite'], SCRIPT),
            (['.robob', 'userdata', 'statev2.sqlite'], SCRIPT),
            (['.local', 'share', 'opencode', 'opencode.db'], SCRIPT),
            (['.t3', 'userdata', 'statev2.sqlite'], SCRIPT),
        ]:
            # Every grouping of adjacent segments: one suffix, all split, and
            # partial suffixes such as '.robob/userdata' / 'readonly' / name.
            for boundaries in range(1 << (len(parts) - 1)):
                grouped = [parts[0]]
                for index, part in enumerate(parts[1:]):
                    if boundaries & (1 << index):
                        grouped.append(part)
                    else:
                        grouped[-1] += '/' + part
                with self.subTest(parts=grouped):
                    expression = 'Path.home() / ' + ' / '.join(repr(part) for part in grouped)
                    source = ('from pathlib import Path\nimport sqlite3\n'
                              f'path = {expression}\n'
                              "sqlite3.connect(f'file:{path}?mode=ro', uri=True)\n")
                    script = self.write('tmp/split-replica.py', source)
                    self.assertEqual(self.classify(f'python3 -I {script}'), expected)
                    self.assertEqual(self.classify("python3 -I - <<'PY'\n" + source + 'PY\n'),
                                     READ if expected else None)

        script = self.write('tmp/split-name.py',
                            'from pathlib import Path\nimport sqlite3\n'
                            'path = Path.home() / ".robob" / "userdata" / ("statev2" + ".sqlite")\n'
                            'sqlite3.connect(str(path))\n')
        self.assertEqual(self.classify(f'python3 -I {script}'), SCRIPT)

    def test_replica_does_not_hide_another_database(self):
        for other in ['statev2.sqlite', 'opencode.db', 'userdata/state.sqlite']:
            for extension, interpreter, source in [
                ('mjs', 'node',
                 'const replica = ".robob/userdata/readonly/state.sqlite";\n'
                 f'new Database("{other}");\n'),
                ('py', 'python3 -I',
                 'import sqlite3\nreplica = ".robob/userdata/readonly/state.sqlite"\n'
                 f'sqlite3.connect({other!r})\n'),
            ]:
                with self.subTest(other=other, extension=extension):
                    script = self.write('tmp/mixed-replica.' + extension, source)
                    self.assertEqual(self.classify(f'{interpreter} {script}'), SCRIPT)

    def test_database_reference_skips_replica_and_keeps_source_offset(self):
        source = 'const replica = ".robob/userdata/readonly/state.sqlite";\nnew Database("statev2.sqlite");'
        match = guard._database_reference(source)
        self.assertEqual(match[0], 'statev2.sqlite')
        self.assertEqual(match.start(), source.index('statev2.sqlite'))

    def test_replica_paths_cannot_be_transformed_before_opening(self):
        node_replica = '(process.env.HOME + "/.robob/userdata/readonly/state.sqlite")'
        node_rows = [
            ('exact', 'replica', None),
            ('replace-directory', 'replica.replace("/readonly/", "/")', SCRIPT),
            ('replace-name', 'replica.replace("/readonly/", "/").replace("state", "statev2")', SCRIPT),
            ('replace-all', 'replica.replaceAll("/readonly/", "/")', SCRIPT),
            ('join-traversal', 'path.join(replica, "../..", path.basename(replica))', SCRIPT),
            ('resolve-traversal', 'path.resolve(replica, "../..", path.basename(replica))', SCRIPT),
            ('dirname', 'path.join(path.dirname(path.dirname(replica)), path.basename(replica))', SCRIPT),
            ('helper', 'rewrite(replica)', SCRIPT),
        ]
        for name, expression, expected in node_rows:
            for assigned in (False, True):
                target = expression
                source = ('import { DatabaseSync } from "node:sqlite";\n'
                          'import path from "node:path";\n')
                if assigned:
                    source += f'const replica = {node_replica};\n'
                else:
                    target = expression.replace('replica', node_replica)
                source += f'new DatabaseSync({target}, {{readOnly: true}});\n'
                with self.subTest(language='node', operation=name, assigned=assigned):
                    script = self.write('tmp/derived-replica.mjs', source)
                    self.assertEqual(self.classify(f'node {script}'), expected)
                    self.assertEqual(self.classify("node --input-type=module <<'JS'\n" + source + 'JS\n'),
                                     READ if expected else None)

        python_rows = [
            ('exact', 'str(replica)', None),
            ('replace-directory', 'str(replica).replace("/readonly/", "/")', SCRIPT),
            ('replace-name', 'str(replica).replace("/readonly/", "/").replace("state", "statev2")', SCRIPT),
            ('join-traversal', 'os.path.join(str(replica), "../..", replica.name)', SCRIPT),
            ('parent', 'replica.parent.parent / replica.name', SCRIPT),
            ('with-name', 'replica.parent.parent / "statev2.sqlite"', SCRIPT),
            ('helper', 'rewrite(replica)', SCRIPT),
        ]
        for name, expression, expected in python_rows:
            for suffix in ['".robob/userdata/readonly/state.sqlite"',
                           '".robob/userdata" / "readonly" / "state.sqlite"']:
                source = ('from pathlib import Path\nimport sqlite3\nimport os\n'
                          f'replica = Path.home() / {suffix}\n'
                          f'p = {expression}\n'
                          'sqlite3.connect("file:" + str(p) + "?mode=ro", uri=True)\n')
                with self.subTest(language='python', operation=name, suffix=suffix):
                    script = self.write('tmp/derived-replica.py', source)
                    self.assertEqual(self.classify(f'python3 -I {script}'), expected)
                    self.assertEqual(self.classify("python3 -I - <<'PY'\n" + source + 'PY\n'),
                                     READ if expected else None)

    def test_original_replica_probe_is_allowed(self):
        source = Path(__file__).resolve().parents[3] / 'scripts/probe-readonly-identity.ts'
        original = source.read_text()
        for expression, expected in [
            ('values.replica', None),
            ('values.replica.replace("/readonly/", "/")', SCRIPT),
            ('values.replica.replace("/readonly/", "/").replace("state", "statev2")', SCRIPT),
            ('NodePath.join(values.replica, "../..", NodePath.basename(values.replica))', SCRIPT),
            ('rewrite(values.replica)', SCRIPT),
        ]:
            with self.subTest(expression=expression):
                content = original.replace('DatabaseSync(values.replica,', f'DatabaseSync({expression},')
                script = self.write('tmp/original-probe.ts', content)
                self.assertEqual(self.classify(f'node {script} --thread-id x'), expected)
        script = self.write('tmp/eval-probe.ts', original.replace(
            'const db = new', 'eval(\'values.replica = values.replica.replace("/readonly/", "/")\');\nconst db = new'))
        self.assertEqual(self.classify(f'node {script} --thread-id x'), SCRIPT)

    def test_replica_default_requires_builtin_parser(self):
        rewrite = 'function parseArgs(input) { return {values: {replica: input.options.replica.default.replace("/readonly/", "/")}}; }\n'
        self.write('tmp/custom-parser-lib.mjs', 'export ' + rewrite + 'export default {parseArgs};\n')
        options = '{options: {replica: {type: "string", default: process.env.HOME + "/.robob/userdata/readonly/state.sqlite"}}}'
        rows = [
            ('builtin', 'import * as NodeUtil from "node:util";\n', 'NodeUtil.parseArgs', None),
            ('builtin-alias', 'import * as utility from "node:util";\n', 'utility.parseArgs', None),
            ('local-function', rewrite, 'parseArgs', SCRIPT),
            ('local-object', rewrite + 'const NodeUtil = {parseArgs};\n', 'NodeUtil.parseArgs', SCRIPT),
            ('custom-namespace', 'import * as NodeUtil from "./custom-parser-lib.mjs";\n', 'NodeUtil.parseArgs', SCRIPT),
            ('custom-default', 'import NodeUtil from "./custom-parser-lib.mjs";\n', 'NodeUtil.parseArgs', SCRIPT),
            ('custom-named', 'import {parseArgs} from "./custom-parser-lib.mjs";\n', 'parseArgs', SCRIPT),
            ('comment-import', '// import * as NodeUtil from "node:util";\n' + rewrite + 'const NodeUtil = {parseArgs};\n', 'NodeUtil.parseArgs', SCRIPT),
            ('string-import', 'const prose = \'import * as NodeUtil from "node:util";\';\n' + rewrite + 'const NodeUtil = {parseArgs};\n', 'NodeUtil.parseArgs', SCRIPT),
            ('mutated-builtin', 'import * as NodeUtil from "node:util";\n' + rewrite + 'NodeUtil.parseArgs = parseArgs;\n', 'NodeUtil.parseArgs', SCRIPT),
        ]
        for name, setup, parser, expected in rows:
            source = ('import {DatabaseSync} from "node:sqlite";\n' + setup +
                      f'const {{ values }} = {parser}({options});\n'
                      'new DatabaseSync(values.replica, {readOnly:true});\n')
            with self.subTest(parser=name):
                script = self.write('tmp/parser-probe.mjs', source)
                self.assertEqual(self.classify(f'node {script}'), expected)
                self.assertEqual(self.classify("node --input-type=module <<'JS'\n" + source + 'JS\n'), READ if expected else None)

    def test_replica_default_cannot_hide_parser_argument_overrides(self):
        replica = '{type:"string", default:process.env.HOME + "/.robob/userdata/readonly/state.sqlite"}'
        options = '{replica:' + replica + '}'
        live = 'process.env.HOME + "/.robob/userdata/" + ["statev2", "sqlite"].join(".")'
        prefix = ('import {DatabaseSync} from "node:sqlite";\nimport * as NodeUtil from "node:util";\n'
                  f'const liveArgs = ["--replica", {live}];\nconst args = liveArgs;\nconst overrides = {{args:liveArgs}};\n')
        rows = [
            ('args-after', '', '{options:' + options + ', args:liveArgs}'),
            ('args-before', '', '{args:liveArgs, options:' + options + '}'),
            ('quoted', '', '{options:' + options + ', "args":liveArgs}'),
            ('computed', '', '{options:' + options + ', ["args"]:liveArgs}'),
            ('escaped', '', '{options:' + options + r', "\u0061rgs":liveArgs}'),
            ('shorthand', '', '{options:' + options + ', args}'),
            ('getter', '', '{options:' + options + ', get args() {return liveArgs;}}'),
            ('prototype', '', '{options:' + options + ', __proto__:{args:liveArgs}}'),
            ('spread', '', '{options:' + options + ', ...overrides}'),
            ('extra-argument', '', '{options:' + options + '}, overrides'),
            ('argv-write', 'process.argv = ["node", "probe", ...liveArgs];\n', '{options:' + options + '}'),
            ('argv-splice', 'process.argv.splice(2, Infinity, ...liveArgs);\n', '{options:' + options + '}'),
            ('argv-computed', 'process["argv"] = ["node", "probe", ...liveArgs];\n', '{options:' + options + '}'),
            ('argv-alias', 'const proc = process; proc.argv = ["node", "probe", ...liveArgs];\n', '{options:' + options + '}'),
        ]
        for key in ['replica', '"replica"', '["replica"]', r'"\u0072eplica"']:
            rows.append(('duplicate-option-' + key, '', '{options:{replica:' + replica + ', ' + key + ':{type:"string", default:' + live + '}}}'))
        for name, setup, config in rows:
            source = prefix + setup + f'const {{ values }} = NodeUtil.parseArgs({config});\nnew DatabaseSync(values.replica, {{readOnly:true}});\n'
            with self.subTest(override=name):
                script = self.write('tmp/args-probe.mjs', source)
                self.assertEqual(self.classify(f'node {script}'), SCRIPT)
                self.assertEqual(self.classify("node --input-type=module <<'JS'\n" + source + 'JS\n'), READ)
        for module in ['node:process', 'process', r'node:\u0070rocess']:
            for setup in [
                f'import {{argv}} from "{module}";\nargv.splice(2, Infinity, ...liveArgs);\n',
                f'import {{argv as input}} from "{module}";\ninput.splice(2, Infinity, ...liveArgs);\n',
                f'import runtime from "{module}";\nruntime.argv.splice(2, Infinity, ...liveArgs);\n',
                f'import * as runtime from "{module}";\nruntime.argv.splice(2, Infinity, ...liveArgs);\n',
            ]:
                source = prefix + setup + f'const {{ values }} = NodeUtil.parseArgs({{options:{options}}});\nnew DatabaseSync(values.replica);\n'
                with self.subTest(module=module, setup=setup):
                    script = self.write('tmp/imported-argv.mjs', source)
                    self.assertEqual(self.classify(f'node {script}'), SCRIPT)
                    self.assertEqual(self.classify("node --input-type=module <<'JS'\n" + source + 'JS\n'), READ)
        for access in ['globalThis.process', 'globalThis["process"]', 'global.process', 'global["process"]',
                       '(await import("node:process")).default', 'require("node:process")']:
            source = prefix + access + '.argv.splice(2, Infinity, ...liveArgs);\n' + f'const {{ values }} = NodeUtil.parseArgs({{options:{options}}});\nnew DatabaseSync(values.replica);\n'
            with self.subTest(access=access):
                script = self.write('tmp/global-argv.mjs', source)
                self.assertEqual(self.classify(f'node {script}'), SCRIPT)
                self.assertEqual(self.classify("node --input-type=module <<'JS'\n" + source + 'JS\n'), READ)
        original = (Path(__file__).resolve().parents[3] / 'scripts/probe-readonly-identity.ts').read_text()
        source = original.replace('  },\n});\nif', '  },\n  args: ["--thread-id", "x", "--replica", ' + live + '],\n});\nif', 1)
        self.assertNotEqual(source, original)
        script = self.write('tmp/original-probe-args.ts', source)
        self.assertEqual(self.classify(f'node {script} --thread-id x'), SCRIPT)
        self.assertEqual(self.classify("node --input-type=module <<'JS'\n" + source + 'JS\n'), READ)

    def test_replica_default_rejects_untracked_argument_capabilities(self):
        self.write('tmp/unproven-runtime.mjs', 'export {default as runtime} from "node:process";\n')
        prefix = ('import {DatabaseSync} from "node:sqlite";\nimport * as NodeUtil from "node:util";\n'
                  'const liveArgs = ["--replica",process.env.HOME+"/.robob/userdata/"+["statev2","sqlite"].join(".")];\n')
        rows = [
            ('computed-constructor', '', '({})["constructor"]["constructor"]("return process")()'),
            ('optional-computed', '', '({})?.["constructor"]?.["constructor"]("return process")()'),
            ('optional-first', '', '({})?.["constructor"]["constructor"]("return process")()'),
            ('optional-last', '', '({})["constructor"]?.["constructor"]("return process")()'),
            ('optional-spaced', '', '({}) ?. ["constructor"] ?. ["constructor"]("return process")()'),
            ('optional-aliased', 'const key = ["constr","uctor"].join("");\n', '({})?.[key]?.[key]("return process")()'),
            ('quoted-destructure', 'const {"constructor": make} = Number;\n', 'make("return process")()'),
            ('escaped-destructure', 'const {"constr\\u0075ctor": make} = Number;\n', 'make("return process")()'),
            ('computed-destructure', 'const {["constructor"]: make} = Number;\n', 'make("return process")()'),
            ('aliased-destructure', 'const key = ["constr","uctor"].join("");\nconst {[key]: make} = Number;\n', 'make("return process")()'),
            ('computed-alias', 'const key = ["constr","uctor"].join("");\n', '({})[key][key]("return process")()'),
            ('object-descriptor', 'import * as OtherUtil from "node:util";\n', 'Object.getOwnPropertyDescriptor(Object.getPrototypeOf(OtherUtil.parseArgs),"constructor").value("return process")()'),
            ('vm', 'import * as VM from "node:vm";\n', 'VM.runInThisContext("process")'),
            ('custom-import', 'import {runtime as importedRuntime} from "./unproven-runtime.mjs";\n', 'importedRuntime'),
        ]
        for name, setup, runtime in rows:
            source = (prefix + setup + f'const runtime = {runtime};\nruntime.argv.splice(2,Infinity,...liveArgs);\n'
                      'const { values } = NodeUtil.parseArgs({options:{replica:{type:"string",default:process.env.HOME+"/.robob/userdata/readonly/state.sqlite"}}});\n'
                      'new DatabaseSync(values.replica);\n')
            with self.subTest(capability=name):
                script = self.write('tmp/argument-capability.mjs', source)
                self.assertEqual(self.classify(f'node {script}'), SCRIPT)
                self.assertEqual(self.classify("node --input-type=module <<'JS'\n" + source + 'JS\n'), READ)

    def test_replica_path_builders_must_be_builtin_imports(self):
        for operation in ['join', 'resolve']:
            for declaration, callee in [
                (f'const {operation} = (h, s) => (h + s).replace("/readonly/", "/");', operation),
                (f'const fake = {{ {operation}: (h, s) => (h + s).replace("/readonly/", "/") }};', 'fake.' + operation),
                (f'// import * as fake from "node:path";\nconst fake = {{ {operation}: (h, s) => (h + s).replace("/readonly/", "/") }};', 'fake.' + operation),
                (f'const prose = \'import * as fake from "node:path";\';\nconst fake = {{ {operation}: (h, s) => (h + s).replace("/readonly/", "/") }};', 'fake.' + operation),
            ]:
                source = ('import { DatabaseSync } from "node:sqlite";\n' + declaration + '\n'
                          f'new DatabaseSync({callee}(process.env.HOME, "/.robob/userdata/readonly/state.sqlite"), {{readOnly:true}});\n')
                with self.subTest(operation=operation, declaration=declaration):
                    script = self.write('tmp/custom-builder.mjs', source)
                    self.assertEqual(self.classify(f'node {script}'), SCRIPT)
                    self.assertEqual(self.classify("node --input-type=module <<'JS'\n" + source + 'JS\n'), READ)

    def test_replica_option_property_spellings_cannot_hide_transforms(self):
        source = (Path(__file__).resolve().parents[3] / 'scripts/probe-readonly-identity.ts').read_text()
        for property_name in ['replica', r'\u0072eplica', r'\x72eplica', r'\u{72}eplica', r'rep\u006cica']:
            for quote in ["'", '"']:
                for rename in ['', '.replace("state", "statev2")']:
                    access = f'values[{quote}{property_name}{quote}].replace("/readonly/", "/")' + rename
                    content = source.replace('DatabaseSync(values.replica,', f'DatabaseSync({access},')
                    with self.subTest(access=access):
                        script = self.write('tmp/escaped-option.ts', content)
                        self.assertEqual(self.classify(f'node {script} --thread-id x'), SCRIPT)
                        self.assertEqual(self.classify("node --input-type=module <<'JS'\n" + content + 'JS\n'), READ)

    def test_replica_readers_must_be_builtin_imports(self):
        for declaration, reader in [
            ('class DatabaseSync { constructor(p) { return new Sqlite.DatabaseSync(p.replace("/readonly/", "/")); } }', 'DatabaseSync'),
            ('const fake = { DatabaseSync: class { constructor(p) { return new Sqlite.DatabaseSync(p.replace("/readonly/", "/")); } } };', 'fake.DatabaseSync'),
            ('// import { DatabaseSync } from "node:sqlite";\nclass DatabaseSync { constructor(p) { return new Sqlite.DatabaseSync(p.replace("/readonly/", "/")); } }', 'DatabaseSync'),
        ]:
            source = ('import * as Sqlite from "node:sqlite";\n' + declaration + '\n'
                      f'new {reader}(process.env.HOME + "/.robob/userdata/readonly/state.sqlite", {{readOnly:true}});\n')
            with self.subTest(reader=reader, declaration=declaration):
                script = self.write('tmp/custom-reader.mjs', source)
                self.assertEqual(self.classify(f'node {script}'), SCRIPT)
                self.assertEqual(self.classify("node --input-type=module <<'JS'\n" + source + 'JS\n'), READ)
        source = ('from pathlib import Path\nimport sqlite3\nfrom custom import connect_legacy\n'
                  'class sqlite3:\n    connect = connect_legacy\n'
                  'path = Path.home() / ".robob/userdata/readonly/state.sqlite"\n'
                  'sqlite3.connect(f"file:{path}?mode=ro", uri=True)\n')
        script = self.write('tmp/custom-reader.py', source)
        self.assertEqual(self.classify(f'python3 -I {script}'), SCRIPT)
        self.assertEqual(self.classify("python3 -I - <<'PY'\n" + source + 'PY\n'), READ)

    def test_escaped_identifiers_cannot_hide_replica_transforms(self):
        for parameter in [r'Node\u0050ath', r'Node\u{50}ath', r'\u004eodePath', r'NodePat\u0068']:
            source = ('import * as NodePath from "node:path";\n'
                      'import { DatabaseSync } from "node:sqlite";\n'
                      f'function probe({parameter}) {{\n'
                      '  new DatabaseSync(NodePath.join(process.env.HOME, "/.robob/userdata/readonly/state.sqlite"));\n'
                      '}\nprobe({join: (h, s) => (h + s).replace("/readonly/", "/")});\n')
            with self.subTest(parameter=parameter):
                script = self.write('tmp/escaped-shadow.mjs', source)
                self.assertEqual(self.classify(f'node {script}'), SCRIPT)
                self.assertEqual(self.classify("node --input-type=module <<'JS'\n" + source + 'JS\n'), READ)

    def test_python_replica_import_bindings_must_be_unambiguous(self):
        prefix = ('from pathlib import Path\nimport sqlite3\n'
                  'from custom import connect_legacy, reader\n'
                  'class E(Exception):\n    connect = staticmethod(connect_legacy)\n'
                  'path = Path.home() / ".robob/userdata/readonly/state.sqlite"\n')
        call = 'sqlite3.connect(str(path))\n'
        for name, source in [
            ('except', prefix + 'try:\n    raise E()\nexcept Exception as sqlite3:\n    ' + call),
            ('except-star', prefix + 'try:\n    raise E()\nexcept* Exception as sqlite3:\n    ' + call),
            ('conditional-import', 'from pathlib import Path\nfrom custom import sqlite3\nif False:\n    import sqlite3\n'
             'sqlite3.connect(str(Path.home() / ".robob/userdata/readonly/state.sqlite"))\n'),
            ('star-import', prefix + 'from custom import *\n' + call),
            ('match-as', prefix + 'match reader:\n    case sqlite3:\n        ' + call),
            ('match-star', prefix + 'match [reader]:\n    case [*sqlite3]:\n        ' + call),
            ('match-rest', prefix + 'match {"connect": connect_legacy}:\n    case {**sqlite3}:\n        ' + call),
            ('with', prefix + 'with reader as sqlite3:\n    ' + call),
            ('for', prefix + 'for sqlite3 in [reader]:\n    ' + call),
            ('assignment', prefix + 'sqlite3 = reader\n' + call),
            ('globals', prefix + 'globals()["sqlite3"] = reader\n' + call),
            ('locals', prefix + 'locals()["sqlite3"] = reader\n' + call),
            ('vars', prefix + 'vars()["sqlite3"] = reader\n' + call),
            ('module-attribute', prefix + 'import sys\nsys.modules[__name__].sqlite3 = reader\n' + call),
            ('module-dict', prefix + 'import sys\nsys.modules[__name__].__dict__["sqlite3"] = reader\n' + call),
            ('module-import', prefix + 'from sys import modules as registry\nregistry[__name__].sqlite3 = reader\n' + call),
            ('function-globals', prefix + 'def binding(): pass\nbinding.__globals__["sqlite3"] = reader\n' + call),
            ('path-shadow', prefix + 'class Path:\n    home = staticmethod(reader.home)\n'
             'sqlite3.connect(str(Path.home() / ".robob/userdata/readonly/state.sqlite"))\n'),
            ('builder-mutation', prefix + 'import os\nos.path.join = reader\n'
             'sqlite3.connect(os.path.join(str(Path.home()), ".robob/userdata/readonly/state.sqlite"))\n'),
        ]:
            with self.subTest(binding=name):
                script = self.write('tmp/rebound-reader.py', source)
                self.assertEqual(self.classify(f'python3 -I {script}'), SCRIPT)
                self.assertEqual(self.classify("python3 -I - <<'PY'\n" + source + 'PY\n'), READ)

    def test_python_replica_namespace_alias_mutations_are_refused(self):
        for alias in ['p = os.path', 'q = os.path\np = q', 'p = [os.path][0]',
                      'p = {"path": os.path}["path"]', 'p = (lambda: os.path)()']:
            for rename in ['', '.replace("state", "statev2")']:
                source = ('import os, sqlite3\n' + alias + '\n'
                          'p.join = lambda h, s: h + "/" + s.replace("/readonly/", "/")' + rename + '\n'
                          'sqlite3.connect(os.path.join(os.path.expanduser("~"), ".robob/userdata/readonly/state.sqlite"))\n')
                with self.subTest(alias=alias, rename=rename):
                    script = self.write('tmp/namespace-alias.py', source)
                    self.assertEqual(self.classify(f'python3 -I {script}'), SCRIPT)
                    self.assertEqual(self.classify("python3 -I - <<'PY'\n" + source + 'PY\n'), READ)

    def test_escaped_probe_option_references_cannot_hide_transforms(self):
        original = (Path(__file__).resolve().parents[3] / 'scripts/probe-readonly-identity.ts').read_text()
        for identifier in [r'v\u0061lues', r'v\u{61}lues', r'\u0076alues', r'value\u0073']:
            for rename in ['', '.replace("state", "statev2")']:
                expression = identifier + '.replica.replace("/readonly/", "/")' + rename
                source = original.replace('DatabaseSync(values.replica,', f'DatabaseSync({expression},')
                with self.subTest(identifier=identifier, rename=rename):
                    script = self.write('tmp/escaped-values.ts', source)
                    self.assertEqual(self.classify(f'node {script} --thread-id x'), SCRIPT)
                    self.assertEqual(self.classify("node --input-type=module <<'JS'\n" + source + 'JS\n'), READ)
        for line_end in ['\r', '\r\n', '\u2028', '\u2029']:
            source = original.replace('const db = new', '// comment' + line_end +
                                      'values.replica = values.replica.replace("/readonly/", "/");\nconst db = new')
            with self.subTest(line_end=repr(line_end)):
                script = self.write('tmp/comment-option.ts', source)
                self.assertEqual(self.classify(f'node {script} --thread-id x'), SCRIPT)
                self.assertEqual(self.classify("node --input-type=module <<'JS'\n" + source + 'JS\n'), READ)

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
                rule, cause = guard.classify_detail((fixtures / name).read_text(), str(self.root))
                self.assertIsNone(rule, cause)
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
                    # Remote-only (#221): a broken heredoc fails on the box, not here.
                    self.assertEqual(self.classify(wrapper(payload)),
                                     None if remote_only_offbox(wrapper(payload)) else UNRESOLVED)
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
            # The quoted ';' keeps this payload on the box (#221).
            ('S=safe.py; offbox run -- bash -c \'S=tmp/live.py; python3 "$S"\'', None),
            ('S=safe.py; offbox run -- bash -c \'python3 tmp/live.py\'', SCRIPT),
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
        # A literal $ reaches offbox, whose fallback refuses it (#221); the
        # guard counts double-quoted $ as caller-expanded and keeps checking.
        for operand, expected in [("'$S'", None), (r'\$S', None), (r'"\$S"', UNRESOLVED)]:
            with self.subTest(operand=operand):
                self.assertEqual(self.classify('S=tmp/live.py; offbox run -- python3 ' + operand), expected)
        self.assertIsNone(self.classify('D=tmp; S=live; offbox run -- python3 "$D"/\'$S.py\''))
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
        self.assertEqual(self.classify(literal_prefix + 'cp /elsewhere/x.py "$D/a.py"; python3 -I "$D/a.py"'), UNRESOLVED)
        self.assertEqual(self.classify(literal_prefix + 'printf x > "$D/a.py"; python3 -I "$D/a.py"'), UNRESOLVED)
        self.table([
            (prefix + 'python3 -I "$D/b.py"', UNRESOLVED),
            (prefix + 'D=$(other); python3 -I "$D/a.py"', UNRESOLVED),
            (prefix + 'D=/elsewhere; python3 -I "$D/a.py"', None),
            (prefix + 'cp /elsewhere/x.py "$D/a.py"; python3 -I "$D/a.py"', UNRESOLVED),
            (prefix + 'mv /elsewhere/x.py "$D/a.py"; python3 -I "$D/a.py"', UNRESOLVED),
            (prefix + 'printf x > "$D/a.py"; python3 -I "$D/a.py"', UNRESOLVED),
            (prefix + 'cat /elsewhere/x.py > "$D/a.py"; python3 -I "$D/a.py"', UNRESOLVED),
            (prefix + 'tee "$D/a.py" < /elsewhere/x.py; python3 -I "$D/a.py"', UNRESOLVED),
            (prefix + 'E="$D"; cat > "$E/a.py" <<\'EOF\'\nprint(2)\nEOF\npython3 -I "$D/a.py"', UNRESOLVED),
            (prefix + 'cat > "${D}/a.py" <<\'EOF\'\nprint(2)\nEOF\npython3 -I "$D/a.py"', UNRESOLVED),
            (prefix + "python3 -I '$D/a.py'", UNRESOLVED),
            ('cat > "$X/a.py" <<\'EOF\'\nprint(1)\nEOF\npython3 -I "$X/a.py"', UNRESOLVED),
            ('D=$(mktemp -d); if true; then cat > "$D/a.py" <<\'EOF\'\nprint(1)\nEOF\nfi; python3 -I "$D/a.py"', UNRESOLVED),
            (prefix + 'cat >> "$D/a.py" <<\'EOF\'\nprint(2)\nEOF\npython3 -I "$D/a.py"', None),
            (prefix + 'cat >> "$D/a.py" <<\'EOF\'\nopen(' + repr(LIVE) + ').read()\nEOF\npython3 -I "$D/a.py"', SCRIPT),
            ('D=$(mktemp -d); cat >> "$D/a.py" <<\'EOF\'\nprint(1)\nEOF\npython3 -I "$D/a.py"', UNRESOLVED),
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
        invoke = '\npython3 -I "$D/a.py"'
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
        other_edit = "python3 -I - <<'PY'\nfrom pathlib import Path\np=Path('tmp/report.txt')\np.write_text('report')\nPY"
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
        invoke = '\npython3 -I "$D/a.py"'
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
                    command = prefix + "python3 -I - <<'PY'\n" + source + '\nPY' + invoke
                    self.assertEqual(self.classify(command), expected)
        source = 'from pathlib import Path\n' + writes[0].format(dest='tmp/unrelated.txt')
        command = prefix + "python3 -I - <<'PY'\n" + source + '\nPY' + invoke
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
                if name in {'card3650', 'torssh31'}:
                    rule, cause = guard.classify_detail(command, str(self.root))
                    self.assertEqual(rule, UNRESOLVED, cause)
                    self.assertIn('executable provenance or mutation proof failed', cause)
                else:
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
                self.assertEqual(self.classify(command), UNRESOLVED if label == 'positive-literal-writer' else None)
        fallback = '$D' + str(self.root / 'tmp/read.py')
        command = 'D=$(mktemp -d invalid) && cat > "' + fallback + '" <<\'EOF\'\nprint(1)\nEOF\npython3 -I "' + fallback + '"'
        self.assertEqual(self.classify(command), SCRIPT)
        self.table([
            ('D=$(printf tmp); cat > "$D/new.py" <<\'EOF\'\nprint(1)\nEOF\npython3 -I "$D/new.py"', UNRESOLVED),
            ('D=$(mktemp -d); cp tmp/read.py "$D/a.py"; chmod a-w "$D/a.py"; cat > "$D/a.py" <<\'EOF\'\nprint(1)\nEOF\npython3 -I "$D/a.py"', UNRESOLVED),
            ('D=$(mktemp -d); cat > "$D/a.py" <<\'EOF\'\nprint(1)\nEOF\n./writer.sh; cat > "$D/a.py" <<\'EOF\'\nprint(2)\nEOF\npython3 -I "$D/a.py"', UNRESOLVED),
        ])
        bad = 'from pathlib import Path\nq=".robob"\np=Path.home()/q/"userdata"/"statev2.sqlite"\np.read_bytes()\n'
        for assignment in ['D=tmp', 'D=$(mktemp -d)']:
            command = assignment + '; cat > "$D/new.py" <<\'EOF\'\n' + bad + 'EOF\ncat >> "$D/new.py" <<\'EOF\'\nq=".robob"\nprint(1)\nEOF\npython3 -I "$D/new.py"'
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
                command = 'D=$(mktemp -d ' + template + '); mkdir tmp/safe.py && cat > "' + target + '" <<\'EOF\'\nprint(1)\nEOF\npython3 -I "' + target + '"'
                self.assertEqual(self.classify(command), expected)

    def test_isolated_migrate_source_and_note_case_matrix(self):
        isolated_source_cases.write_migration_helpers(self.root)
        source = Path(__file__).resolve().parents[3] / 'apps/server/scripts/migrate-dev-db.ts'
        self.write('apps/server/scripts/migrate-dev-db.ts', source.read_text())
        self.write('package.json', json.dumps({'scripts': {'migrate-dev-db': 'node apps/server/scripts/migrate-dev-db.ts'}}))
        (self.root / 'link.sqlite').symlink_to(Path.home() / '.robob/userdata/statev2.sqlite')
        for label, command, expected in isolated_source_cases.cases(self.root):
            with self.subTest(case=label, command=command):
                self.assertEqual(guard.classify_detail(command, str(self.root))[0], expected)

    def test_isolated_migrate_history_attach_provenance(self):
        isolated_source_cases.write_migration_helpers(self.root)
        source = Path(__file__).resolve().parents[3] / 'apps/server/scripts/migrate-dev-db.ts'
        original = source.read_text()
        script = 'apps/server/scripts/migrate-dev-db.ts'
        self.write('package.json', json.dumps({'scripts': {'migrate-dev-db': 'node ' + script}}))
        invocations = ('node ' + script, 'vp run migrate-dev-db')
        arguments = ' --source /tmp/copy.sqlite --base-dir /tmp/dev-home'
        attaches = {
            alias: 'ATTACH DATABASE ${`${NodeURL.pathToFileURL(' + operand + ').href}?mode=ro`} AS ' + alias
            for operand, alias in (('sourcePath', 'src'), ('archivePath', 'cold'), ('basePath', 'base'))
        }
        rows = [('current-source', original, None)]

        def mutation(label, before, after):
            self.assertIn(before, original, label)
            changed = original.replace(before, after)
            self.assertNotEqual(changed, original, label)
            rows.append((label, changed, SCRIPT))

        rows.append(('fourth-attach', original + '\nyield* sql`ATTACH DATABASE "file:/tmp/fourth.sqlite?mode=ro" AS fourth`;\n', SCRIPT))
        for alias, attach in attaches.items():
            mutation(alias + '-writable', attach, attach.replace('?mode=ro', ''))
            mutation(alias + '-wrong-alias', attach, attach.replace('AS ' + alias, 'AS other'))
            mutation(alias + '-alias-suffix', attach, attach + '_other')
            mutation(alias + '-missing', attach, '')
        for alias, operand in (('cold', 'archivePath'), ('base', 'basePath')):
            for label, replacement in (
                ('literal-live', json.dumps(LIVE)),
                ('shared-home', 'path.join(sharedHome, "userdata", "statev2.sqlite")'),
                ('home', 'path.join(NodeOS.homedir(), ".t3", "userdata", "statev2.sqlite")'),
                ('environment', 'process.env.HISTORY_DB'),
                ('other-variable', 'otherPath'),
            ):
                mutation(alias + '-attach-' + label, attaches[alias],
                         attaches[alias].replace('(' + operand + ')', '(' + replacement + ')'))
                if alias == 'cold':
                    mutation('cold-initializer-' + label, 'const archivePath = archiveFilename(sourcePath);',
                             'const archivePath = ' + replacement + ';')
                else:
                    mutation('base-resolver-' + label, 'resolveHistoryBasePath(path, sourcePath, baseRows)', replacement)
            for statement in ('const alias = ' + operand + ';', operand + ' = "/tmp/other.sqlite";',
                              '[' + operand + '] = other;', 'mutate(' + operand + ');'):
                mutation(alias + '-unknown-use-' + statement, attaches[alias], attaches[alias] + '; ' + statement)
        mutation('base-rows-wrong-schema', 'SELECT filename FROM src.ardud_history_base_archive LIMIT 2',
                 'SELECT filename FROM main.ardud_history_base_archive LIMIT 2')
        mutation('base-rows-mutation', 'const basePath = yield* Effect.try({',
                 'baseRows.push({filename: "other.sqlite"}); const basePath = yield* Effect.try({')
        for helper, module in (('archiveFilename', 'historyArchiveSql'), ('resolveHistoryBasePath', 'historySourceFiles')):
            mutation(helper + '-wrong-import', '../src/ardud/persistence/' + module + '.ts', './other.ts')
            for prefix in ('xx', '.x', 'x.'):
                mutation(helper + '-import-prefix-' + prefix, '../src/ardud/persistence/' + module + '.ts',
                         prefix + '/src/ardud/persistence/' + module + '.ts')
            rows.append((helper + '-redefined', original + '\n' + helper + ' = () => "/tmp/other.sqlite";\n', SCRIPT))
        mutation('duplicate-cold-initializer', 'const archivePath = archiveFilename(sourcePath);',
                 'const archivePath = archiveFilename(sourcePath); const archivePath = archiveFilename(sourcePath);')
        mutation('detach-other-schema', 'const name of ["base", "cold", "src"]', 'const name of ["other", "cold", "src"]')
        for label, changed, expected in rows:
            self.write(script, changed)
            for invocation in invocations:
                with self.subTest(case=label, invocation=invocation):
                    self.assertEqual(self.classify(invocation + arguments), expected)

    def test_isolated_migrate_history_file_isolation(self):
        isolated_source_cases.write_migration_helpers(self.root)
        original = (Path(__file__).resolve().parents[3] / 'apps/server/scripts/migrate-dev-db.ts').read_text()
        script = 'apps/server/scripts/migrate-dev-db.ts'
        self.write(script, original)
        self.write('package.json', json.dumps({'scripts': {'migrate-dev-db': 'node ' + script}}))
        for filename in ('copy.sqlite', 'archive.sqlite', 'statev2.pre-shrink-copy.sqlite'):
            for shape, expected in (('absent', None), ('copy', None), ('isolated-symlink', None),
                                    ('live-symlink', READ), ('live-archive-symlink', READ),
                                    ('hard-link', UNRESOLVED), ('directory', UNRESOLVED)):
                folder = self.root / (filename + '-' + shape)
                folder.mkdir()
                source = folder / 'copy.sqlite'
                target = folder / filename
                if filename != source.name:
                    source.write_text('isolated source')
                if shape == 'copy':
                    target.write_text('isolated copy')
                elif shape == 'isolated-symlink':
                    copy = self.write('isolated/' + folder.name, 'isolated copy')
                    target.symlink_to(copy)
                elif shape == 'live-symlink':
                    target.symlink_to(LIVE)
                elif shape == 'live-archive-symlink':
                    target.symlink_to(Path.home() / '.robob/userdata/archive.sqlite')
                elif shape == 'hard-link':
                    copy = self.write('isolated/' + folder.name, 'isolated copy')
                    os.link(copy, target)
                    if filename == source.name:
                        expected = None
                elif shape == 'directory':
                    target.mkdir()
                for invocation in ('node ' + script, 'vp run migrate-dev-db'):
                    with self.subTest(file=filename, shape=shape, invocation=invocation):
                        command = invocation + ' --source ' + str(source) + ' --base-dir /tmp/dev-home'
                        self.assertEqual(self.classify(command), expected)
                        if filename == source.name and shape == 'hard-link':
                            with patch.object(guard, 'protected_databases', return_value={copy}):
                                self.assertEqual(self.classify(command), READ)
        # Derivation uses the source spelling, even when src itself is a link.
        source = self.root / 'source-alias/copy.sqlite'
        source.parent.mkdir()
        source.symlink_to(self.write('actual/copy.sqlite', 'isolated copy'))
        (source.parent / 'archive.sqlite').symlink_to(LIVE)
        self.assertEqual(self.classify('node ' + script + ' --source ' + str(source) + ' --base-dir /tmp/dev-home'), READ)

    def test_isolated_migrate_path_normalization_and_sidecars(self):
        isolated_source_cases.write_migration_helpers(self.root)
        script = 'apps/server/scripts/migrate-dev-db.ts'
        self.write(script, (Path(__file__).resolve().parents[3] / script).read_text())
        hop = self.root / 'inputs/hop'
        elsewhere = self.root / 'elsewhere/deep'
        elsewhere.mkdir(parents=True)
        hop.parent.mkdir()
        hop.symlink_to(elsewhere, target_is_directory=True)
        self.write('elsewhere/copy.sqlite', 'isolated')
        self.write('inputs/copy.sqlite', 'isolated').unlink()
        (hop.parent / 'copy.sqlite').symlink_to(LIVE)
        (hop.parent / 'live-home').symlink_to(Path.home() / '.robob', target_is_directory=True)
        for flag, filename in (('--source', 'copy.sqlite'), ('--base-dir', 'live-home')):
            paths = (str(hop) + '/../' + filename, str(hop) + '/./../' + filename,
                     str(hop.parent) + '//hop//../' + filename,
                     'inputs/hop/../' + filename)
            for value in paths:
                for separator in (' ', '='):
                    other = '--base-dir /tmp/dev-home' if flag == '--source' else '--source /tmp/copy.sqlite'
                    command = 'node ' + script + ' ' + flag + separator + shlex.quote(value) + ' ' + other
                    with self.subTest(flag=flag, value=value, separator=separator):
                        self.assertEqual(self.classify(command), READ)
            for value in ('-', 'copy*.sqlite', 'copy?.sqlite', 'copy[1].sqlite', 'copy$UNKNOWN.sqlite', 'copy`unknown`.sqlite'):
                other = '--base-dir /tmp/dev-home' if flag == '--source' else '--source /tmp/copy.sqlite'
                with self.subTest(flag=flag, nonliteral=value):
                    self.assertEqual(self.classify('node ' + script + ' ' + flag + ' ' + shlex.quote(value) + ' ' + other), UNRESOLVED)
        for name in ('copy.sqlite', 'archive.sqlite', 'statev2.pre-shrink-copy.sqlite'):
            for suffix in ('-wal', '-shm', '-journal'):
                for shape, expected in (('copy', None), ('live-link', READ), ('hard-link', UNRESOLVED)):
                    folder = self.root / (name + suffix + shape)
                    folder.mkdir()
                    source = folder / 'copy.sqlite'
                    source.write_text('isolated')
                    primary = folder / name
                    primary.write_text('isolated')
                    sidecar = Path(str(primary) + suffix)
                    if shape == 'copy':
                        sidecar.write_text('isolated')
                    elif shape == 'live-link':
                        sidecar.symlink_to(LIVE + suffix)
                    else:
                        copy = self.write('sidecars/' + folder.name + suffix, 'isolated')
                        os.link(copy, sidecar)
                        if name == source.name:
                            expected = None
                    command = 'node ' + script + ' --source ' + str(source) + ' --base-dir /tmp/dev-home'
                    with self.subTest(file=name, suffix=suffix, shape=shape):
                        self.assertEqual(self.classify(command), expected)
                        if name == source.name and shape == 'hard-link':
                            with patch.object(guard, 'protected_databases', return_value={Path(str(copy)[:-len(suffix)])}):
                                self.assertEqual(self.classify(command), READ)

    def test_isolated_migrate_physical_working_directory(self):
        isolated_source_cases.write_migration_helpers(self.root)
        script = self.write('apps/server/scripts/migrate-dev-db.ts',
                            (Path(__file__).resolve().parents[3] / 'apps/server/scripts/migrate-dev-db.ts').read_text())
        live_home = self.root / 'fake-home'
        readonly = live_home / '.robob/userdata/readonly'
        readonly.mkdir(parents=True)
        alias = self.root / 'cwd-alias'
        alias.symlink_to(readonly, target_is_directory=True)
        rows = (('--source', '../statev2.sqlite', '--base-dir /tmp/dev-home'),
                ('--base-dir', '../..', '--source /tmp/copy.sqlite'))
        for flag, value, other in rows:
            for separator in (' ', '='):
                for cwd in (alias, readonly):
                    with self.subTest(flag=flag, separator=separator, cwd=str(cwd)), patch.object(Path, 'home', return_value=live_home):
                        command = 'node ' + str(script) + ' ' + flag + separator + value + ' ' + other
                        self.assertEqual(guard.classify(command, str(cwd)), READ)

    def test_isolated_migrate_source_hard_links_to_live_history(self):
        isolated_source_cases.write_migration_helpers(self.root)
        script = 'apps/server/scripts/migrate-dev-db.ts'
        self.write(script, (Path(__file__).resolve().parents[3] / script).read_text())
        home = self.root / 'fake-home'
        roots = ('.robob/userdata', '.t3/userdata', '.local/share/opencode', '.robob/userdata/readonly')
        suffixes = ('', '-wal', '-shm', '-journal')
        alias_index = 0
        for root in roots:
            for name in ('statev2.sqlite', 'archive.sqlite', 'statev2.pre-shrink-live.sqlite'):
                for live_suffix in suffixes:
                    live = home / root / (name + live_suffix)
                    live.parent.mkdir(parents=True, exist_ok=True)
                    live.write_text('fixture only')
                    for input_suffix in suffixes:
                        folder = self.root / ('alias-' + str(alias_index))
                        alias_index += 1
                        folder.mkdir()
                        source = folder / 'copy.sqlite'
                        if input_suffix:
                            source.write_text('isolated')
                        os.link(live, Path(str(source) + input_suffix))
                        command = 'node ' + script + ' --source ' + str(source) + ' --base-dir /tmp/dev-home'
                        with self.subTest(root=root, name=name, live_suffix=live_suffix, input_suffix=input_suffix), patch.object(Path, 'home', return_value=home):
                            self.assertEqual(self.classify(command), READ)
                    live.unlink()

    def test_isolated_migrate_source_hard_links_to_symlinked_live_history(self):
        isolated_source_cases.write_migration_helpers(self.root)
        script = 'apps/server/scripts/migrate-dev-db.ts'
        self.write(script, (Path(__file__).resolve().parents[3] / script).read_text())
        home = self.root / 'fake-home'
        roots = ('.robob/userdata', '.t3/userdata', '.local/share/opencode', '.robob/userdata/readonly')
        suffixes = ('', '-wal', '-shm', '-journal')
        alias_index = 0
        for root in roots:
            for name in ('statev2.sqlite', 'archive.sqlite', 'statev2.pre-shrink-live.sqlite'):
                primary = home / root / name
                primary.parent.mkdir(parents=True, exist_ok=True)
                physical = self.write('physical/' + str(alias_index) + '/live.sqlite', 'fixture only')
                primary.symlink_to(physical)
                for spelling in ('lexical', 'physical'):
                    for live_suffix in suffixes:
                        live = Path(str(primary if spelling == 'lexical' else physical) + live_suffix)
                        live.write_text('fixture only')
                        for input_suffix in suffixes:
                            folder = self.root / ('alias-' + str(alias_index))
                            alias_index += 1
                            folder.mkdir()
                            source = folder / 'copy.sqlite'
                            if input_suffix:
                                source.write_text('isolated')
                            os.link(live.resolve(), Path(str(source) + input_suffix))
                            command = 'node ' + script + ' --source ' + str(source) + ' --base-dir /tmp/dev-home'
                            with self.subTest(root=root, name=name, spelling=spelling, live_suffix=live_suffix, input_suffix=input_suffix), patch.object(Path, 'home', return_value=home):
                                self.assertEqual(self.classify(command), READ)
                        alias = self.root / ('symlink-' + str(alias_index) + '.sqlite')
                        alias.symlink_to(live.resolve())
                        with self.subTest(root=root, name=name, spelling=spelling, live_suffix=live_suffix, input_shape='symlink'), patch.object(Path, 'home', return_value=home):
                            self.assertEqual(self.classify('node ' + script + ' --source ' + str(alias) + ' --base-dir /tmp/dev-home'), READ)
                        if live_suffix:
                            live.unlink()


    def test_node_test_database_names_and_live_root_siblings(self):
        for label, source, expected in isolated_source_cases.database_name_sources():
            self.write('names.test.mjs', source)
            for command in ('node --test names.test.mjs', 'node names.test.mjs',
                            'offbox run -- node --test names.test.mjs'):
                with self.subTest(case=label, command=command):
                    self.assertEqual(self.classify(command), expected)

    @trusted_node_test
    def test_installer_node_test_and_parse_only_commands(self):
        root = Path(__file__).resolve().parents[3]
        for command in (
            'node --test apps/desktop/scripts/install-robob-fast.test.mjs',
            'node --check apps/desktop/scripts/install-robob-fast.mjs',
            'offbox run -- node --test apps/desktop/scripts/install-robob-fast.test.mjs',
            'vp test run apps/desktop/scripts/install-robob-fast.test.mjs',
        ):
            with self.subTest(command=command):
                self.assertIsNone(guard.classify(command, str(root)))
        rule, cause = guard.classify_detail('zsh -n apps/desktop/scripts/install-robob-fast.zsh', str(root))
        self.assertEqual(rule, UNRESOLVED)
        self.assertIn('zsh: implicit startup unproved', cause)

    def test_js_temp_database_fixture_reporters(self):
        repo = Path(__file__).resolve().parents[3]
        target = 'integrations/stream-recovery/test/cli.test.mjs'
        for command in (f'node --test {target}', 'node --test integrations/stream-recovery/test',
                        f'offbox run -- node --test {target}', f"offbox run -- 'node --test {target}'",
                        f'offbox run --no-fallback --bg -- node --test {target}'):
            with self.subTest(command=command):
                self.assertIsNone(guard.classify(command, str(repo)))
        source = '''import { test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directories = [];
const unrelatedLabel = '.robob';
test('restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'spectrum-early-restart-'));
  directories.push(directory);
  const path = join(directory, 'state.sqlite');
  new Database(path);
});
test('recovery', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spectrum-download-recovery-')));
  const path = join(root, 'state.sqlite');
  new Database(path);
});
test('failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'spectrum-download-failure-'));
  const path = join(root, 'state.sqlite');
  new Database(path);
});
'''
        self.write('test/router.test.ts', source)
        for command in ('bun test test/router.test.ts', 'node --test test/router.test.ts',
                        'offbox run -- bun test test/router.test.ts',
                        "offbox run -- 'bun --version && bun install --frozen-lockfile && bun test test/router.test.ts'"):
            with self.subTest(command=command):
                self.assertIsNone(self.classify(command))

    def test_js_temp_database_keeps_other_database_root_evidence(self):
        setup = 'const root = mkdtempSync(tmpdir()); '
        self.js_mutation_cases((suffix, setup + f'const fixture = join(root, "{suffix}"); ' +
            'readFileSync("~/.config/spectrum-bridge/state.sqlite");') for suffix in (
                '.robob/userdata/statev2.sqlite', 'robob-data/userdata/state.sqlite',
                '.local/share/opencode/opencode.db'))

    def test_js_temp_database_config_strip_cannot_supply_proof(self):
        setup = 'const root = mkdtempSync(tmpdir()); '
        imports = "import {mkdtempSync} from 'node:fs'; import {tmpdir} from 'node:os'; import {join} from 'node:path';\n"
        cases = []
        for tool in ('homedir', 'cwd', 'HOME'):
            source = setup + f'const protectedPath = "~/.config/{tool}/state.sqlite"; ' + \
                'readFileSync(join(root, ".robob/userdata/statev2.sqlite"));'
            checked = imports + source
            stripped = guard._strip_config_dir_db_names(checked, str(self.root))
            self.assertNotEqual(stripped, checked)
            self.assertEqual(guard._js_fixture_source(checked), checked)
            self.assertNotEqual(guard._js_fixture_source(stripped), stripped)
            cases.append((tool, source))
        self.js_mutation_cases(cases)

    def test_js_temp_database_mask_preserves_second_database(self):
        setup = 'const tmpRoot = mkdtempSync(join(tmpdir(), "guard95-")); '
        imports = "import {mkdtempSync} from 'node:fs'; import {tmpdir} from 'node:os'; import {join} from 'node:path';\n"
        live = 'join(homedir(), ".t3/userdata/state.sqlite")'
        fixture = 'join(tmpRoot, "state.sqlite")'
        cases = [
            ('concatenated live join', 'import {homedir} from "node:os"; ' + setup +
             f'readFileSync({fixture} + {live});'),
            ('same-line live join', 'import {homedir} from "node:os"; ' + setup +
             f'readFileSync({fixture}); readFileSync({live});'),
        ]
        fixture = 'join(tmpRoot, ".robob/userdata/statev2.sqlite")'
        live = '"~/.config/spectrum-bridge/state.sqlite"'
        for label, expression in (
                ('concatenated config operand', f'readFileSync({fixture} + {live});'),
                ('nested config reader', f'consume({fixture}, readFileSync({live}));')):
            source = setup + expression
            checked = imports + source
            masked = guard._js_fixture_source(checked)
            self.assertNotEqual(masked, checked)
            self.assertNotIn('statev2.sqlite', masked)
            self.assertIn(live, masked)
            cases.append((label, source))
        self.js_mutation_cases(cases)

    def test_js_temp_database_fixture_expressions(self):
        imports = '''import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import os from 'node:os';
import { join, resolve } from 'node:path';
import path from 'node:path';
'''
        for expression in ('mkdtempSync(tmpdir())', 'await mkdtemp(join(tmpdir(), "case-"))',
                           'fs.mkdtempSync(path.join(os.tmpdir(), "case-"))',
                           'await fsp.mkdtemp(os.tmpdir())',
                           'realpathSync(mkdtempSync(join(tmpdir(), "case-")))',
                           'fs.realpathSync(mkdtempSync(tmpdir()))',
                           'await realpath(await mkdtemp(tmpdir()))'):
            for build in ('join(root, ".robob/userdata/statev2.sqlite")',
                          'path.join(root, ".t3/userdata/state.sqlite")',
                          'resolve(join(root, "nested"), "opencode.db")',
                          '`${root}/.robob/userdata/statev2.sqlite`'):
                self.write('temp.test.ts', imports + f'const root = {expression};\nnew Database({build});')
                with self.subTest(expression=expression, build=build):
                    self.assertIsNone(self.classify('bun test temp.test.ts'))
        for setup, name in (('const fixture = {}; fixture.root = mkdtempSync(tmpdir());', 'fixture.root'),
                            ('const fixture = { root: mkdtempSync(tmpdir()) };', 'fixture.root'),
                            ('let root = mkdtempSync(tmpdir()); const child = join(root, "nested");', 'child')):
            self.write('temp.test.ts', imports + setup + f'new Database(join({name}, ".robob/userdata/statev2.sqlite"));')
            with self.subTest(setup=setup):
                self.assertEqual(self.classify('node --test temp.test.ts'), SCRIPT)
        self.write('temp.test.ts', imports + 'const fixture = {root: mkdtempSync(tmpdir())};\n' +
                   'readFileSync(`${fixture.root}/.robob/userdata/statev2.sqlite`);')
        self.assertEqual(self.classify('bun test temp.test.ts'), SCRIPT)
        self.write('temp.test.ts', imports + 'const root = mkdtempSync(tmpdir()); const child = join(root, "nested");' +
                   'readFileSync(`${child}/.robob/userdata/statev2.sqlite`);')
        self.assertIsNone(self.classify('bun test temp.test.ts'))

    def test_js_temp_database_fixture_near_misses(self):
        imports = '''import { test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
'''
        rows = [
            'new Database(join(homedir(), ".robob/userdata/statev2.sqlite"));',
            'readFileSync(join(process.env.HOME, ".t3/userdata/state.sqlite"));',
            'spawn("sqlite3", ["~/.robob/userdata/statev2.sqlite"]);',
            'readFileSync("~/.local/share/opencode/opencode.db");',
            'let root = mkdtempSync(tmpdir()); root = homedir(); new Database(join(root, ".robob/userdata/statev2.sqlite"));',
            'let root = mkdtempSync(tmpdir()); root = process.env.HOME; new Database(join(root, ".t3/userdata/state.sqlite"));',
            'let root = mkdtempSync(tmpdir()); root = "/Users/ardud/.robob/userdata"; new Database(join(root, "statev2.sqlite"));',
            'const root = mkdtempSync(join(homedir(), ".robob/userdata/x")); new Database(join(root, "statev2.sqlite"));',
            'const root = realpathSync(join(homedir(), ".t3/userdata")); new Database(join(root, "state.sqlite"));',
            'const root = mkdtempSync(tmpdir()); new Database(resolve(root, "/Users/ardud/.robob/userdata/statev2.sqlite"));',
            'const root = mkdtempSync(tmpdir()); new Database(join(root, "../../.robob/userdata/statev2.sqlite"));',
            'const root = mkdtempSync(tmpdir()); new Database(join(root, ".robob/userdata/statev2.sqlite")); readFileSync("~/.robob/userdata/statev2.sqlite");',
            'let root = mkdtempSync(tmpdir()); root += "/../../"; new Database(join(root, ".robob/userdata/statev2.sqlite"));',
            'const fixture = {root: mkdtempSync(tmpdir())}; fixture.root = homedir(); new Database(join(fixture.root, ".robob/userdata/statev2.sqlite"));',
            'const fixture = {root: mkdtempSync(tmpdir())}; fixture["root"] = process.env.HOME; new Database(join(fixture.root, ".t3/userdata/state.sqlite"));',
            'const root = mkdtempSync(tmpdir()); new Database(join(root, ".robob/userdata/statev2.sqlite")); readFileSync(join(process["env"]["HOME"], ".t3/userdata/state.sqlite"));',
            'const tmpdir = () => "/Users/ardud/.robob/userdata"; const root = mkdtempSync(tmpdir()); new Database(join(root, "statev2.sqlite"));',
            'let root = mkdtempSync(tmpdir()); root = externalRoot; new Database(join(root, ".robob/userdata/statev2.sqlite"));',
            'const root = realpathSync(externalRoot); new Database(join(root, ".robob/userdata/statev2.sqlite"));',
            'const root = mkdtempSync("prefix-"); new Database(join(root, ".robob/userdata/statev2.sqlite"));',
            'let fixture = {root: mkdtempSync(tmpdir())}; fixture = externalObject; new Database(join(fixture.root, ".robob/userdata/statev2.sqlite"));',
            'const root = mkdtemp(tmpdir()); new Database(join(root, ".robob/userdata/statev2.sqlite"));',
        ]
        for source in rows:
            self.write('temp.test.ts', imports + source)
            for command in ('bun test temp.test.ts', 'node --test temp.test.ts', 'offbox run -- bun test temp.test.ts'):
                with self.subTest(source=source, command=command):
                    self.assertEqual(self.classify(command), SCRIPT)

    def js_mutation_cases(self, cases, suffixes=('mjs', 'ts')):
        imports = '''import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
'''
        for label, source in cases:
            for suffix in suffixes:
                target = 'mutation.test.' + suffix
                self.write(target, imports + source)
                for command in ('node --test ' + target, 'bun test ' + target,
                                'offbox run -- bun test ' + target, "offbox run -- 'bun test " + target + "'"):
                    with self.subTest(case=label, command=command):
                        self.assertEqual(self.classify(command), SCRIPT)
                        self.adapters(command, SCRIPT)

    def test_js_temp_database_mutation_writes(self):
        home = "['', 'Users', 'ardud'].join('/')"
        setup = "let root = mkdtempSync(join(tmpdir(), 'guard95-')); "
        read = "readFileSync(join(root, '.robob/userdata/statev2.sqlite'));"
        writes = [(op, f'root {op} {home};') for op in
                  ('=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=')]
        writes += [(form, form) for form in (
            '++root;', '--root;', 'root++;', 'root--;',
            f'({{root}} = {{root: {home}}});', f'[root] = [{home}];',
            f'({{path: root}} = {{path: {home}}});', f'({{root = {home}}} = {{}});',
            f'[...root] = [{home}];', f'({{nested: [root]}} = {{nested: [{home}]}});',
            f'for (root of [{home}]) {{}}', f'for (root in {{[{home}]: 1}}) {{}}',
            f'(root) = {home};', f'root! &&= {home};',
            f'`${{root = {home}}}`;',
        )]
        self.js_mutation_cases((label, setup + write + read) for label, write in writes)
        self.js_mutation_cases((label + ' property',
            'const fixture = {root: mkdtempSync(tmpdir())}; ' +
            write.replace('root', 'fixture.root') +
            "readFileSync(join(fixture.root, '.robob/userdata/statev2.sqlite'));")
            for label, write in writes if label in {'&&=', '||=', '??=', '*=', '++root;', 'root++;'})

    def test_js_temp_database_object_escape_mutations(self):
        home = "['', 'Users', 'ardud'].join('/')"
        setup = "const fixture = {root: mkdtempSync(join(tmpdir(), 'guard95-'))}; "
        read = "readFileSync(join(fixture.root, '.robob/userdata/statev2.sqlite'));"
        mutations = [
            ('alias', f'const other = fixture; other.root = {home};'),
            ('alias chain', f'const other = fixture; const alias = other; alias.root = {home};'),
            ('object alias', f'const other = {{fixture}}; other.fixture.root = {home};'),
            ('array alias', f'const other = [fixture]; other[0].root = {home};'),
            ('Object.assign', f'Object.assign(fixture, {{root: {home}}});'),
            ('Object.defineProperty', f'Object.defineProperty(fixture, "root", {{value: {home}}});'),
            ('Reflect.set', f'Reflect.set(fixture, "root", {home});'),
            ('opaque call', f'mutate(fixture, {home});'),
            ('return alias', f'function get() {{return fixture;}} get().root = {home};'),
            ('closure alias', f'const get = () => fixture; get().root = {home};'),
            ('computed property', f'fixture["root"] = {home};'),
            ('delete property', 'delete fixture.root;'),
            ('opaque method', 'fixture.mutate();'),
            ('tagged template', f'mutate`${{fixture}}`;'),
            ('second interpolation assign', f'`${{fixture.root}}/${{Object.assign(fixture, {{root: {home}}})}}`;'),
            ('second interpolation call', f'`${{fixture.root}}/${{mutate(fixture)}}`;'),
        ]
        self.js_mutation_cases((label + ' ' + name, (setup + mutation + read).replace('fixture', name))
            for label, mutation in mutations for name in ('fixture', '$fixture', 'fixture$', '$fixture$'))
        self.js_mutation_cases((label, initializer + read) for label, initializer in (
            ('spread override', f'const fixture = {{root: mkdtempSync(tmpdir()), ...{{root: {home}}}}};'),
            ('quoted override', f'const fixture = {{root: mkdtempSync(tmpdir()), "root": {home}}};'),
            ('computed override', f'const fixture = {{root: mkdtempSync(tmpdir()), [key]: {home}}};'),
        ))

    def test_js_temp_database_iteration_pattern_writes(self):
        home = "['', 'Users', 'ardud'].join('/')"
        setup = "let root = mkdtempSync(join(tmpdir(), 'guard95-')); "
        read = "readFileSync(join(root, '.robob/userdata/statev2.sqlite'));"
        patterns = [('[root]', f'[[{home}]]'),
                    ('{value: root}', f'[{{value: {home}}}]'),
                    ('{nested: [root]}', f'[{{nested: [{home}]}}]'),
                    ('[{value: root}]', f'[[{{value: {home}}}]]'),
                    ('[...root]', f'[[{home}]]'),
                    (f'{{value: root = {home}}}', '[{}]')]
        self.js_mutation_cases((form + ' ' + pattern,
            setup + f'{form} ({pattern} of {values}) {{}}' + read)
            for pattern, values in patterns for form in ('for', 'for await'))
        self.js_mutation_cases(('for-in ' + pattern,
            setup + f'for ({pattern} in {{[{home}]: 1}}) {{}}' + read)
            for pattern in ('[root]', '{value: root}', '{nested: [root]}'))
        self.js_mutation_cases(('property loop ' + pattern,
            'const fixture = {root: mkdtempSync(tmpdir())}; ' +
            f'for ({pattern} of {values}) {{}}' +
            "readFileSync(join(fixture.root, '.robob/userdata/statev2.sqlite'));")
            for pattern, values in (('[fixture.root]', f'[[{home}]]'),
                                    ('{value: fixture.root}', f'[{{value: {home}}}]')))

    def test_js_temp_database_slash_lexing(self):
        home = "const homeRoot = ['', 'Users', 'ardud'].join('/'); "
        scalar = "let root = mkdtempSync(tmpdir()); " + home
        receiver = "const fixture = {root: mkdtempSync(tmpdir())}; " + home
        read = "readFileSync(join(root, '.robob/userdata/statev2.sqlite'));"
        divisions = ('1 / 2', 'numerator / denominator', 'getValue() / 2',
                     'values[0] / 2', '1 / /value/.test(value)', '1 /\n2',
                     '1 / /* comment */ 2', 'of / 2', 'value! / 2', 'value<number> / 2')
        self.js_mutation_cases((value + ' ' + label,
            setup + f'let fraction = {value}; {write}; fraction = {value};' + tail)
            for value in divisions for label, setup, write, tail in (
                ('scalar', scalar, 'root = homeRoot', read),
                ('receiver', receiver, 'Object.assign(fixture, {root: homeRoot})',
                 read.replace('root,', 'fixture.root,'))))
        imports = ("import {mkdtempSync} from 'node:fs'; import {tmpdir} from 'node:os'; "
                   "import {join} from 'node:path'; ")
        # Regexes in known expression positions and ordinary arithmetic do not
        # mutate the fixture. Control-flow slashes keep the original scan.
        for expression in ('const regex = /root = live; \\/ [a-z]/gi;',
                           'check(/root = live/);', 'function pattern() { return /root = live/; }',
                           'let fraction = 1 / 2; fraction /= 2;'):
            self.write('slash.test.ts', imports + 'const root = mkdtempSync(tmpdir()); ' +
                       expression + "const path = join(root, 'state.sqlite');")
            for command in ('node --test slash.test.ts', 'bun test slash.test.ts'):
                with self.subTest(expression=expression, command=command):
                    self.assertIsNone(self.classify(command))
        self.js_mutation_cases((label, setup + code + tail) for label, setup, code, tail in (
            ('control regex', scalar, 'if (ready) /root = live/.test(value); root = homeRoot;', read),
            ('block regex', receiver, '{} /value/.test(value); Object.assign(fixture, {root: homeRoot});',
             read.replace('root,', 'fixture.root,'))))

    def test_js_temp_database_const_binding_spans(self):
        imports = ("import {mkdtempSync} from 'node:fs'; import {tmpdir} from 'node:os'; "
                   "import {join} from 'node:path'; ")
        fixture = "const root = mkdtempSync(tmpdir()); join(root, 'state.sqlite');"
        self.write('sibling.test.ts', imports + f'test("a", () => {{{fixture}}}); test("b", () => {{{fixture}}});')
        for command in ('node --test sibling.test.ts', 'bun test sibling.test.ts',
                        'offbox run -- bun test sibling.test.ts', "offbox run -- 'bun test sibling.test.ts'"):
            with self.subTest(command=command):
                self.assertIsNone(self.classify(command))
                self.adapters(command)
        setup = "const root = mkdtempSync(tmpdir()); const homeRoot = ['', 'Users', 'ardud'].join('/'); "
        read = "readFileSync(join(root, '.robob/userdata/statev2.sqlite'));"
        bindings = (
            'let root = homeRoot;', 'const root = homeRoot;', 'var root = homeRoot;',
            'function root() {}', 'function * root() {}', 'class root {}',
            'const {root} = value;', 'const {path: root} = value;', 'let [root] = value;',
            'try {} catch (root) {}', 'const fn = (root) => root;', 'const fn = root => root;',
            'function fn(root) {}', 'function fn<T>(root: string) {}',
            'const fn = ({root}) => root;', 'const fn = ([root]) => root;',
            'const fn = (root: string): string => root;',
            'import {root} from "fixture";', 'import root from "fixture";',
        )
        self.js_mutation_cases((binding, setup + read + '{' + binding + '}') for binding in bindings)
        self.js_mutation_cases((label, setup + body) for label, body in (
            ('inner read', '{ let root = homeRoot; ' + read + '}'),
            ('arrow read', 'const fn = (root) => {' + read + '}; fn(homeRoot);'),
            ('catch read', 'try {throw homeRoot;} catch (root) {' + read + '}'),
        ))

    def test_js_temp_database_method_parameter_bindings(self):
        setup = "const root = mkdtempSync(tmpdir()); const homeRoot = ['', 'Users', 'ardud'].join('/'); "
        read = "readFileSync(join(root, '.robob/userdata/statev2.sqlite'));"
        methods = ('with', 'if', 'while', 'for', 'switch', 'read', "'read'", '"read"',
                   '[methodName]', '1', 'async read', '*read', 'set path', 'static read')
        self.js_mutation_cases((container + ' ' + method, setup + (
            'const reader = {' + method + '(root) {' + read + '}};' if container == 'object' else
            'class Reader {' + method + '(root) {' + read + '}}'))
            for container in ('object', 'class') for method in methods
            if not (container == 'object' and method == 'static read'))

    def test_js_temp_database_typed_return_parameter_bindings(self):
        setup = "const root = mkdtempSync(tmpdir()); const homeRoot = ['', 'Users', 'ardud'].join('/'); "
        read = "readFileSync(join(root, '.robob/userdata/statev2.sqlite'));"
        types = ('Buffer', "ReadResult['bytes']", 'ReadResult[keyof ReadResult]',
                 "Array<ReadResult['bytes']>", "ReadResult['bytes'][]", 'readonly Buffer[]',
                 "'ok' | undefined", "Buffer & {tag: 'bytes'}", '{bytes: Buffer}',
                 '() => Buffer', '[Buffer, number]', 'T extends string ? Buffer : never',
                 'root is string')
        self.js_mutation_cases(((header + ' ' + annotation, setup + source)
            for annotation in types for header, source in (
                ('class', 'class Reader { read<T>(root: string): ' + annotation + ' {' + read + '}}'),
                ('object', 'const reader = { read(root: string): ' + annotation + ' {' + read + '}};'),
                ('function', 'function read<T>(root: string): ' + annotation + ' {' + read + '}'),
                ('arrow', 'const read = (root: string): ' + annotation + ' => {' + read + '};'),
            )), suffixes=('ts',))

    def test_js_temp_database_optional_member_divisions(self):
        read = "readFileSync(join(root, '.robob/userdata/statev2.sqlite'));"
        home = "const homeRoot = ['', 'Users', 'ardud'].join('/'); "
        self.js_mutation_cases((keyword + ' ' + member + ' ' + declaration,
            declaration + ' root = mkdtempSync(tmpdir()); ' + home +
            f'const metrics = {{{keyword}: 1}}; let fraction = {member} / 2; ' +
            ('root = homeRoot; ' + read if declaration == 'let' else '{ let root = homeRoot; ' + read + '}') +
            f'fraction = {member} / 2;')
            for keyword in ('return', 'throw', 'case', 'typeof', 'void', 'delete', 'in', 'instanceof', 'of', 'await', 'yield')
            for member in (f'metrics?.{keyword}', f'metrics?. /* comment */ {keyword}', f'metrics.{keyword}')
            for declaration in ('let', 'const'))

    def test_js_temp_database_nested_template_fallback(self):
        home = "const homeRoot = ['', 'Users', 'ardud'].join('/'); "
        read = "readFileSync(join(root, '.robob/userdata/statev2.sqlite'));"
        expressions = ('({ok: true}, root = homeRoot)',
                       '(() => { const value = {}; root = homeRoot; return 1; })()',
                       '(() => { const root = homeRoot; return root; })()',
                       "('}', root = homeRoot)",
                       '(root = homeRoot)', 'root++',
                       '(function () { const root = homeRoot; return root; })()',
                       '({value: `nested`}, root = homeRoot)',
                       '({value: {nested: true}}, root = homeRoot)')
        self.js_mutation_cases((expression + ' ' + declaration,
            declaration + ' root = mkdtempSync(tmpdir()); ' + home + '`${' + expression + '}`; ' + read)
            for expression in expressions for declaration in ('let', 'const'))
        self.js_mutation_cases((label, 'const root = mkdtempSync(tmpdir()); ' + template + read)
            for label, template in (
                ('unclosed nested template', 'const id = `${encodeURIComponent(`nested`)}; '),
                ('unbalanced interpolation', 'const id = `${encodeURIComponent(`nested`)`; '),
                ('nested DB name', 'const id = `${encodeURIComponent(`state.sqlite`)}`; '),
                ('ambiguous interpolation slash', 'const id = `${value / 2}`; '),
            ))
        imports = ("import {mkdtempSync} from 'node:fs'; import {tmpdir} from 'node:os'; "
                   "import {join} from 'node:path'; ")
        self.write('unrelated.test.ts', imports + 'const dir = mkdtempSync(tmpdir()); ' +
                   'const db = join(dir, "opencode.db"); ' +
                   'const id = `message:provider:opencode:native-item:${encodeURIComponent(`msg_${kind}:text:0`)}`;')
        for command in ('node --test unrelated.test.ts', 'bun test unrelated.test.ts',
                        'offbox run -- bun test unrelated.test.ts', "offbox run -- 'bun test unrelated.test.ts'"):
            with self.subTest(command=command):
                self.assertIsNone(self.classify(command))
                self.adapters(command)

    def test_js_temp_database_parameter_bindings_shadow_outer_roots(self):
        imports = '''import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'guard95-'));
'''
        read = "readFileSync(join(root, '.robob/userdata/statev2.sqlite'))"
        rows = [
            f'function readLive(root) {{ {read}; }} readLive("/Users/x");',
            f'async function readLive(root) {{ {read}; }} readLive("/Users/x");',
            f'const readLive = function(root) {{ {read}; }}; readLive("/Users/x");',
            f'const readLive = (root) => {{ {read}; }}; readLive("/Users/x");',
            f'const readLive = async (root) => {{ {read}; }}; readLive("/Users/x");',
            f'const readLive = root => {{ {read}; }}; readLive("/Users/x");',
            f'const readLive = root => {read}; readLive("/Users/x");',
            f'const readLive = (root: string) => {{ {read}; }}; readLive("/Users/x");',
            f'const readLive = (root: string): void => {{ {read}; }}; readLive("/Users/x");',
            f'const readLive = async (root: string): Promise<void> => {{ {read}; }}; readLive("/Users/x");',
            f'const readLive = (root: string): {{ok: boolean}} => {{ {read}; return {{ok:true}}; }}; readLive("/Users/x");',
            f'function readLive(root: string): void {{ {read}; }} readLive("/Users/x");',
            f'const object = {{ readLive(root) {{ {read}; }} }}; object.readLive("/Users/x");',
            f'function readLive({{root}}) {{ {read}; }} readLive({{root:"/Users/x"}});',
            f'try {{ throw "/Users/x"; }} catch(root) {{ {read}; }}',
            f'for (const root of ["/Users/x"]) {{ {read}; }}',
            f'{{ const {{root}} = {{root: "/Users/x"}}; {read}; }}',
            f'{{ const [root] = ["/Users/x"]; {read}; }}',
        ]
        for source in rows:
            self.write('shadow.test.ts', imports + source)
            for command in ('node --test shadow.test.ts', 'bun test shadow.test.ts'):
                with self.subTest(source=source, command=command):
                    self.assertEqual(self.classify(command), SCRIPT)

    def test_js_temp_database_property_receiver_shadowing(self):
        imports = '''import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const fixture = { root: mkdtempSync(join(tmpdir(), 'guard95-')) };
'''
        read = "readFileSync(join(fixture.root, '.robob/userdata/statev2.sqlite'))"
        rows = [
            f'function readLive(fixture) {{ {read}; }} readLive({{root:"/Users/x"}});',
            f'async function readLive(fixture) {{ {read}; }} readLive({{root:"/Users/x"}});',
            f'function readLive<T>(fixture: {{root:string}}) {{ {read}; }} readLive({{root:"/Users/x"}});',
            f'async function readLive<T extends {{value: Array<string>}}>(fixture: {{root:string}}): Promise<void> {{ {read}; }} readLive({{root:"/Users/x"}});',
            f'const readLive = function<T>(fixture: Fixture) {{ {read}; }}; readLive({{root:"/Users/x"}});',
            f'const readLive = async <T>(fixture: Fixture): Promise<void> => {{ {read}; }}; readLive({{root:"/Users/x"}});',
            f'const object = {{ readLive<T>(fixture: Fixture) {{ {read}; }} }}; object.readLive({{root:"/Users/x"}});',
            f'const object = {{ async readLive<T>(fixture: Fixture): Promise<void> {{ {read}; }} }}; object.readLive({{root:"/Users/x"}});',
            f'class Reader {{ readLive<T>(fixture: Fixture): void {{ {read}; }} }} new Reader().readLive({{root:"/Users/x"}});',
            f'const readLive = function(fixture) {{ {read}; }}; readLive({{root:"/Users/x"}});',
            f'const readLive = (fixture) => {{ {read}; }}; readLive({{root:"/Users/x"}});',
            f'const readLive = fixture => {read}; readLive({{root:"/Users/x"}});',
            f'const readLive = async (fixture: Fixture): Promise<void> => {{ {read}; }}; readLive({{root:"/Users/x"}});',
            f'const object = {{ readLive(fixture) {{ {read}; }} }}; object.readLive({{root:"/Users/x"}});',
            f'function readLive({{fixture}}) {{ {read}; }} readLive({{fixture:{{root:"/Users/x"}}}});',
            f'try {{ throw {{root:"/Users/x"}}; }} catch(fixture) {{ {read}; }}',
            f'for (const fixture of [{{root:"/Users/x"}}]) {{ {read}; }}',
            f'{{ const fixture = {{root:"/Users/x"}}; {read}; }}',
            f'{{ const {{fixture}} = {{fixture:{{root:"/Users/x"}}}}; {read}; }}',
            f'{{ class fixture {{ static root = "/Users/x"; }} {read}; }}',
            f'{{ class fixture {{ static root = "/home/x"; }} {read}; }}',
            f'const object = {{ ["readLive"]<T>(fixture: Fixture) {{ {read}; }} }}; object.readLive({{root:"/Users/x"}});',
            f'const object = {{ [method]<T>(fixture: Fixture) {{ {read}; }} }}; object[method]({{root:"/Users/x/folder/.."}});',
            f'{{ class fixture {{ static root = {json.dumps(str(Path.home()))}; }} {read}; }}',
            f'import {{cwd}} from "node:process"; const object = {{ ["readLive"]<T>(fixture: Fixture) {{ {read}; }} }}; object.readLive({{root:cwd()}});',
        ]
        for source in rows:
            self.write('shadow.test.mjs', imports + source)
            for command in ('node --test shadow.test.mjs', 'bun test shadow.test.mjs'):
                with self.subTest(source=source, command=command):
                    self.assertEqual(self.classify(command), SCRIPT)

    def test_search_patterns_are_data_and_targets_remain_protected(self):
        for command in (
            "rg -n 'statev2 guard|names.*state.sqlite|test.*fixture' integrations/harness-hooks --glob '*.py' --glob '*.ts' --glob '*.sh' | head -40",
            "grep -rn 'statev2.sqlite' integrations/", "rg -e 'opencode\\.db' src/",
            "rg -n '~/.robob/userdata/statev2.sqlite' src/",
            "rg -e '~/.robob/userdata/statev2.sqlite' src/", "rg --regexp='~/.robob/userdata/statev2.sqlite' src/",
            "grep -rne '~/.robob/userdata/statev2.sqlite' src/", "rg -- '~/.robob/userdata/statev2.sqlite' src/",
            "rg -e x -e '~/.robob/userdata/statev2.sqlite' src/", "grep --regexp '~/.robob/userdata/statev2.sqlite' src/",
            "rg -e'~/.robob/userdata/statev2.sqlite' src/", "grep -n -e '~/.robob/userdata/statev2.sqlite' -- src/",
        ):
            with self.subTest(command=command):
                self.assertIsNone(self.classify(command))
        for command in (
            'rg x ~/.robob/userdata/statev2.sqlite', 'grep -a foo ~/.t3/userdata/statev2.sqlite',
            'rg -e x -- ~/.robob/userdata/statev2.sqlite', 'grep --regexp=x ~/.local/share/opencode/opencode.db',
            'rg -g ~/.robob/userdata/statev2.sqlite x src/',
            'rg --glob=statev2.sqlite x ~/.robob/userdata',
            'grep -f ~/.robob/userdata/statev2.sqlite x src/',
            'grep --exclude-from ~/.robob/userdata/statev2.sqlite x src/',
            'rg --ignore-file ~/.robob/userdata/statev2.sqlite x src/',
            'rg -n -- x ~/.robob/userdata/statev2.sqlite',
            'grep -ne x -- ~/.robob/userdata/statev2.sqlite',
            'rg --unknown-option ~/.robob/userdata/statev2.sqlite x',
        ):
            with self.subTest(command=command):
                self.assertEqual(self.classify(command), READ)

    def test_search_runner_option_arity(self):
        # The same short flag can be a switch in grep and a value in rg.
        rows = [
            ('grep', '-T'), ('grep', '-rnT'), ('grep', '--initial-tab'),
            ('grep', '-r'), ('grep', '--recursive'), ('grep', '--color'),
            ('grep', '--color=always'), ('grep', '--colour'),
            ('grep', '-A 2'), ('grep', '-B2'), ('grep', '-C 2'), ('grep', '-m 2'),
            ('grep', '-D read'), ('grep', '-d recurse'),
            ('rg', '-T py'), ('rg', '-r replacement'), ('rg', '-M 80'), ('rg', '-j 2'),
            ('rg', '-E utf-8'), ('rg', '--color always'), ('rg', '--color=always'),
            ('rg', '-g *.ts'), ('rg', '-t ts'),
        ]
        for runner, options in rows:
            for separator in ('', '-- '):
                command = f'{runner} {options} {separator}needle {LIVE}'
                with self.subTest(command=command):
                    self.assertEqual(self.classify(command), READ)
            command = f'{runner} {options} -e needle {LIVE}'
            with self.subTest(command=command):
                self.assertEqual(self.classify(command), READ)
            command = f'{runner} {options} {shlex.quote(LIVE)} src/'
            with self.subTest(command=command):
                self.assertIsNone(self.classify(command))

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
        isolated_source_cases.write_migration_helpers(self.root)
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

    def test_migration_cold_history_paths_fail_closed(self):
        repo = Path(__file__).resolve().parents[3]
        script = 'apps/server/scripts/migrate-dev-db.ts'
        original = (repo / script).read_text()
        isolated_source_cases.write_migration_helpers(self.root)
        self.write('package.json', json.dumps({'scripts': {'migrate-dev-db': 'node ' + script}}))
        commands = [prefix + ' --source /tmp/copy.sqlite --base-dir /tmp/dev-home'
                    for prefix in ('node ' + script, 'vp run migrate-dev-db')]
        mutations = [
            ('archive-home', 'archiveFilename(sourcePath)', 'archiveFilename(path.join(NodeOS.homedir(), ".t3/userdata/statev2.sqlite"))'),
            ('archive-shared-home', 'archiveFilename(sourcePath)', 'archiveFilename(path.join(sharedHome, "userdata/statev2.sqlite"))'),
            ('base-home', 'resolveHistoryBasePath(path, sourcePath, baseRows)', 'resolveHistoryBasePath(path, NodeOS.homedir(), baseRows)'),
            ('base-shared-home', 'resolveHistoryBasePath(path, sourcePath, baseRows)', 'resolveHistoryBasePath(path, sharedHome, baseRows)'),
            ('base-metadata-other-db', 'SELECT filename FROM src.ardud_history_base_archive', 'SELECT filename FROM main.ardud_history_base_archive'),
            ('unproven-destination', 'path.join(stateDir, "statev2.sqlite")', 'path.join("/tmp/elsewhere", "statev2.sqlite")'),
        ]
        for operand, schema in (('sourcePath', 'src'), ('archivePath', 'cold'), ('basePath', 'base')):
            attach = f'ATTACH DATABASE ${{`${{NodeURL.pathToFileURL({operand}).href}}?mode=ro`}} AS {schema}'
            mutations.extend([
                (schema + '-writable', attach, attach.replace('?mode=ro', '')),
                (schema + '-extra-attach', attach, attach + '; ATTACH DATABASE "file:extra.sqlite?mode=ro" AS extra'),
                (schema + '-path-alias', 'const sql = yield* SqlClient.SqlClient;\n  yield* sql`ATTACH',
                 'const leaked = ' + operand + ';\n  const sql = yield* SqlClient.SqlClient;\n  yield* sql`ATTACH'),
            ])
        for operand in ('sourcePath', 'archivePath', 'basePath', '"/tmp/unproven.sqlite"'):
            mutations.append(('non-destination-client-' + operand, 'filename: snapshotPath', 'filename: ' + operand))
        for operand in ('archivePath', 'basePath'):
            mutations.append(('history-write-' + operand, 'const hasArchive = yield* fs.exists(archivePath);',
                              'yield* fs.remove(' + operand + ');\n      const hasArchive = yield* fs.exists(archivePath);'))
        for label, before, after in mutations:
            with self.subTest(case=label):
                self.assertIn(before, original)
                mutated = original.replace(before, after)
                self.assertNotEqual(mutated, original)
                self.write(script, mutated)
                for command in commands:
                    self.assertEqual(self.classify(command), SCRIPT)
        self.write(script, original)
        for command in commands:
            self.assertIsNone(self.classify(command))

    def test_migration_history_helpers_fail_closed(self):
        repo = Path(__file__).resolve().parents[3]
        script = 'apps/server/scripts/migrate-dev-db.ts'
        self.write(script, (repo / script).read_text())
        command = 'node ' + script + ' --source /tmp/copy.sqlite --base-dir /tmp/dev-home'
        helper = 'apps/server/src/ardud/persistence/historySourceFiles.ts'
        archive = 'apps/server/src/ardud/persistence/historyArchiveSql.ts'
        cases = [
            ('helper-home', helper, 'path.dirname(sourcePath)', 'NodeOS.homedir()'),
            ('helper-shared-home', helper, 'path.dirname(sourcePath)', 'sharedHome'),
            ('helper-other-directory', helper, 'path.dirname(sourcePath)', '"/tmp/elsewhere"'),
            ('helper-no-basename-check', helper, 'path.basename(filename) !== filename', 'false'),
            ('helper-no-name-check', helper, '!/^statev2\\.pre-shrink-[^/\\\\]+\\.sqlite$/.test(filename)', 'false'),
            ('helper-extra-io', helper, 'return path.join', 'fs.remove(sourcePath); return path.join'),
            ('archive-home', archive, 'NodePath.dirname(filename)', 'NodeOS.homedir()'),
            ('archive-shared-home', archive, 'NodePath.dirname(filename)', 'sharedHome'),
            ('archive-extra-use', archive, 'export const archiveFilename', 'const alias = NodePath;\nexport const archiveFilename'),
            ('archive-extra-home-read', archive, 'export const archiveFilename',
             'import { readFileSync } from "node:fs"; import { join } from "node:path";\nreadFileSync(join("/Users/ardud/.t3", "userdata", "statev2.sqlite"));\nexport const archiveFilename'),
        ]
        for label, relative, before, after in cases:
            with self.subTest(case=label):
                isolated_source_cases.write_migration_helpers(self.root)
                original = (repo / relative).read_text()
                self.assertIn(before, original)
                self.write(relative, original.replace(before, after))
                self.assertEqual(self.classify(command), SCRIPT)
        for relative in (helper, archive):
            with self.subTest(missing=relative):
                isolated_source_cases.write_migration_helpers(self.root)
                (self.root / relative).unlink()
                self.assertEqual(self.classify(command), SCRIPT)
        isolated_source_cases.write_migration_helpers(self.root)
        self.assertIsNone(self.classify(command))

    def test_migration_archive_module_runtime_fail_closed(self):
        repo = Path(__file__).resolve().parents[3]
        script = 'apps/server/scripts/migrate-dev-db.ts'
        archive = 'apps/server/src/ardud/persistence/historyArchiveSql.ts'
        self.write(script, (repo / script).read_text())
        self.write('package.json', json.dumps({'scripts': {'migrate-dev-db': 'node ' + script}}))
        isolated_source_cases.write_migration_helpers(self.root)
        original = (repo / archive).read_text()
        commands = [prefix + ' --source /tmp/copy.sqlite --base-dir /tmp/dev-home'
                    for prefix in ('node ' + script, 'vp run migrate-dev-db')]
        # Imported modules execute top-level code, even when archiveFilename
        # itself still derives the expected path. Check the whole I/O class.
        homes = (
            ('named-homedir', 'import { homedir } from "node:os";', 'homedir()'),
            ('namespace-homedir', 'import * as NodeOS from "node:os";', 'NodeOS.homedir()'),
            ('user-info', 'import * as os from "node:os";', 'os.userInfo().homedir'),
            ('env-home', '', 'process.env.HOME'),
            ('absolute-home', '', json.dumps(str(Path.home()))),
        )
        operations = (
            ('readFileSync', ''), ('writeFileSync', ', ""'),
            ('appendFileSync', ', ""'), ('truncateSync', ', 0'), ('unlinkSync', ''),
        )
        for home_label, home_import, home in homes:
            for operation, extra in operations:
                injection = ('import { ' + operation + ' } from "node:fs"; ' + home_import + '\n' +
                             operation + '(' + home + ' + "/.t3/userdata/archive.sqlite"' + extra + ');\n')
                for placement, body in (('prepend', injection + original), ('append', original + injection)):
                    for command in commands:
                        with self.subTest(home=home_label, operation=operation, placement=placement, command=command):
                            self.write(archive, body)
                            self.assertEqual(self.classify(command), SCRIPT)
        for label, body in (
            ('extra-import', 'import "./unproven.ts";\n' + original),
            ('extra-runtime', original + '\nthrow new Error("unproven module");\n'),
            ('changed-export', original.replace('table === "orchestration_events"', '(console.log("unproven"), table === "orchestration_events")')),
        ):
            self.assertNotEqual(body, original)
            self.write(archive, body)
            for command in commands:
                with self.subTest(case=label, command=command):
                    self.assertEqual(self.classify(command), SCRIPT)
        self.write(archive, original)
        for command in commands:
            self.assertIsNone(self.classify(command))

    def test_migration_helper_pin_drift_names_module(self):
        repo = Path(__file__).resolve().parents[3]
        script = 'apps/server/scripts/migrate-dev-db.ts'
        self.write(script, (repo / script).read_text())
        self.write('package.json', json.dumps({'scripts': {'migrate-dev-db': 'node ' + script}}))
        commands = [prefix + ' --source /tmp/copy.sqlite --base-dir /tmp/dev-home'
                    for prefix in ('node ' + script, 'vp run migrate-dev-db')]
        # Keep the reviewer's exact import-time write, independent of the matrix.
        repro = ('import { writeFileSync } from "node:fs"; import { homedir } from "node:os"; '
                 'writeFileSync(homedir() + "/.t3/userdata/archive.sqlite", "");\n')
        for name in ('historySourceFiles.ts', 'historyArchiveSql.ts'):
            relative = 'apps/server/src/ardud/persistence/' + name
            original = (repo / relative).read_text()
            for label, body in (('reviewer-repro', repro + original),
                                ('ordinary-drift', original + '\n// helper changed\n'),
                                ('missing', None)):
                isolated_source_cases.write_migration_helpers(self.root)
                if body is None:
                    (self.root / relative).unlink()
                else:
                    self.write(relative, body)
                for command in commands:
                    with self.subTest(module=name, case=label, command=command):
                        rule, cause = guard.classify_detail(command, str(self.root))
                        self.assertEqual(rule, SCRIPT)
                        reason = guard.refusal_reason(rule, cause, str(self.root))
                        self.assertIn(relative, reason)
                        self.assertIn("guard's module pin needs re-auditing", reason)
        isolated_source_cases.write_migration_helpers(self.root)
        for command in commands:
            self.assertIsNone(self.classify(command))

    def test_migration_helpers_belong_to_invoked_script(self):
        repo = Path(__file__).resolve().parents[3]
        relative = 'apps/server/scripts/migrate-dev-db.ts'
        original = (repo / relative).read_text()
        caller, target = self.root / 'caller', self.root / 'target'
        isolated_source_cases.write_migration_helpers(caller)
        isolated_source_cases.write_migration_helpers(target)
        script = self.write('target/' + relative, original)
        link = caller / 'migrate-dev-db.ts'
        link.symlink_to(script)
        forms = ('node ' + str(script), 'node ../target/' + relative, 'node migrate-dev-db.ts')
        history = 'apps/server/src/ardud/persistence/historySourceFiles.ts'
        archive = 'apps/server/src/ardud/persistence/historyArchiveSql.ts'
        # Cross the invocation shape with every helper state: a safe caller
        # must not discharge a missing or live-derived helper beside the script.
        for label, missing, changed in (
            ('valid', None, None),
            ('missing-base-helper', history, None),
            ('missing-archive-helper', archive, None),
            ('live-base-helper', None, history),
            ('live-archive-helper', None, archive),
        ):
            isolated_source_cases.write_migration_helpers(target)
            if missing:
                (target / missing).unlink()
            if changed:
                body = (target / changed).read_text()
                before = ('path.dirname(sourcePath)' if changed == history else 'NodePath.dirname(filename)')
                self.assertIn(before, body)
                (target / changed).write_text(body.replace(before, json.dumps(LIVE)))
            for form in forms:
                with self.subTest(case=label, invocation=form):
                    command = form + ' --source /tmp/copy.sqlite --base-dir /tmp/dev-home'
                    self.assertEqual(guard.classify_detail(command, str(caller))[0], None if label == 'valid' else SCRIPT)
        isolated_source_cases.write_migration_helpers(target)
        # Conversely, a caller's untrusted helper is irrelevant to a safe script.
        (caller / history).write_text('return ' + json.dumps(LIVE) + ';')
        for form in forms:
            with self.subTest(case='unrelated-caller-helper', invocation=form):
                self.assertIsNone(guard.classify_detail(form + ' --source /tmp/copy.sqlite --base-dir /tmp/dev-home', str(caller))[0])
        for flag in ('--preserve-symlinks', '--preserve-symlinks-main'):
            args = ' migrate-dev-db.ts --source /tmp/copy.sqlite --base-dir /tmp/dev-home'
            for placement, command in (
                ('cli', 'node ' + flag + args),
                ('shell-env', 'NODE_OPTIONS=' + shlex.quote(flag) + ' node' + args),
            ):
                with self.subTest(flag=flag, placement=placement):
                    self.assertEqual(guard.classify_detail(command, str(caller))[0], SCRIPT if placement == 'cli' else UNRESOLVED)
            with self.subTest(flag=flag, placement='inherited-env'), patch.dict(os.environ, {'NODE_OPTIONS': flag}):
                self.assertEqual(guard.classify_detail('node' + args, str(caller))[0], UNRESOLVED)

    def test_migration_absolute_home_roots_fail_closed(self):
        repo = Path(__file__).resolve().parents[3]
        relative = 'apps/server/scripts/migrate-dev-db.ts'
        original = (repo / relative).read_text()
        isolated_source_cases.write_migration_helpers(self.root)
        command = 'node ' + relative + ' --source /tmp/copy.sqlite --base-dir /tmp/dev-home'
        anchor = 'const hasArchive = yield* fs.exists(archivePath);'
        self.assertIn(anchor, original)
        for home in ('/Users/ardud', '/home/user', '/root', '/var/root', '/private/var/root', '/private/tmp/home', str(Path.home())):
            for quote in ('"', "'", '`'):
                quoted = lambda value: quote + value + quote
                for label, operand in (
                    ('full-path', quoted(home + '/.t3/userdata/statev2.sqlite')),
                    ('userdata-split', 'path.join(' + quoted(home + '/.t3') + ', "userdata", "statev2.sqlite")'),
                    ('home-split', 'path.resolve(' + quoted(home) + ', ".t3", "userdata", "statev2.sqlite")'),
                ):
                    with self.subTest(home=home, quote=quote, shape=label):
                        self.write(relative, original.replace(anchor, 'yield* fs.readFileString(' + operand + ');\n      ' + anchor))
                        self.assertEqual(self.classify(command), SCRIPT)
        for home in ('process.env.HOME', 'os.homedir()', 'NodeOS.homedir()', 'os.userInfo().homedir'):
            with self.subTest(home=home):
                body = original.replace('import * as NodeOS from "node:os";', 'import * as NodeOS from "node:os"; import * as os from "node:os";')
                operand = 'path.join(' + home + ', ".t3", "userdata", "statev2.sqlite")'
                self.write(relative, body.replace(anchor, 'yield* fs.readFileString(' + operand + ');\n      ' + anchor))
                self.assertEqual(self.classify(command), SCRIPT)
        self.write(relative, original)
        self.assertIsNone(self.classify(command))

    def test_exact_isolated_source_reporters_are_data(self):
        fixture_dir = Path(__file__).with_name('fixtures') / 'isolated-source'
        fixtures = sorted(fixture_dir.glob('*.json'))
        # Freeze all historical roots; stat/open behavior is exercised above
        # against the real migration source and controlled temporary scripts.
        with patch.object(os.path, 'realpath', side_effect=lambda p, *a, **kw: os.path.abspath(p)), patch.object(Path, 'stat', side_effect=FileNotFoundError):
            for fixture in fixtures:
                row = json.loads(fixture.read_text())
                for call_index, call in enumerate(row['commands']):
                    with self.subTest(case=row['case'], fixture=fixture.name):
                        result = guard.classify_detail(call['cmd'], call['workdir'] or row['session_cwd'])
                        if fixture.name in {'s-03.json', 's-04.json', 'o-00.json', 'o-01.json'} or (fixture.name == 't-07.json' and call_index == 1):
                            self.assertEqual(result[0], UNRESOLVED, result)
                            self.assertRegex(result[1], 'executable provenance or mutation proof failed|non-isolated startup')
                        else:
                            self.assertEqual(result, (None, None))

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

    def recall94_fixture(self):
        fixture = Path(__file__).with_name('fixtures') / 'recall94/test_backup_replica.sh'
        target = 'integrations/memory-system/tests/test_backup_replica.sh'
        self.write(target, fixture.read_text())
        self.write('live.sh', 'cat "$HOME/.robob/userdata/statev2.sqlite"\n')
        return target

    def test_recall94_fixture_offbox_options_and_env_prefixes(self):
        target = self.recall94_fixture()
        commands = [
            f'bash {target}',
            f'offbox run -- bash {target}',
            f'offbox run --bg -- bash {target}',
            f'offbox run --no-fallback -- bash {target}',
            f'offbox run --bg --no-fallback -- bash {target}',
            f'offbox run --remote --no-fallback -- bash {target}',
            f'offbox run --size xlarge --include tmp/x --bg -- bash {target}',
            f'offbox run --env=CI=1 --no-fallback -- bash {target}',
            f'RECALL_TOOL_LOG_DIR=$(mktemp -d) bash {target}',
            f'RECALL_TOOL_LOG_DIR=/tmp/x bash {target}',
            f'A=1 B=$(mktemp -d -t foo.XXXXXX) bash {target}',
            f'env RECALL_TOOL_LOG_DIR=/tmp/x bash {target}',
            f'offbox run --bg -- RECALL_TOOL_LOG_DIR=$(mktemp -d) bash {target}',
            f'X=1 offbox run --bg -- env Y=2 bash {target}',
            f'X="$(mktemp -d foo.XXXXXX)" bash {target}',
        ]
        for flag in ('--fresh', '--no-sync', '--git', '--bg', '--no-fallback', '--remote', '--no-retry'):
            commands.append(f'offbox run {flag} -- bash {target}')
        for flag, value in (('--size', 'xlarge'), ('--template', 'default'), ('--base', 'fixture'),
                            ('--env', 'CI=1'), ('--pull', 'tmp/x'), ('--include', 'tmp/x')):
            for separator in (' ', '='):
                commands.append(f'offbox run {flag}{separator}{value} -- bash {target}')
        for command in commands:
            with self.subTest(command=command):
                self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))

    def test_recall94_prefixes_keep_live_reads_and_uncertain_proofs_denied(self):
        target = self.recall94_fixture()
        live = "sqlite3 ~/.robob/userdata/statev2.sqlite 'select 1'"
        commands = [
            f'offbox run --no-fallback -- {live}',
            f'offbox run --bg --remote -- {live}',
            f'offbox run --bg --no-fallback -- bash live.sh',
            'X=$(mktemp -d) bash live.sh', 'X=/tmp/x bash live.sh',
            f'X=$(mktemp -d) {live}',
            f'PATH=/tmp/x:$PATH bash {target}',
            f'offbox run --env=PATH=/tmp/x:$PATH -- bash {target}',
            f'X=$(cat ~/.robob/userdata/statev2.sqlite) bash {target}',
            f'env -i X=1 bash {target}',
            f'offbox run --bogus-flag -- bash {target}',
            f'offbox run --step "bash {target}" -- true',
            f'D=$(mktemp -d); X=$D bash {target}',
        ]
        for flags in ('--fresh', '--no-sync', '--git', '--bg', '--no-fallback', '--remote', '--no-retry',
                      '--size xlarge', '--template=default', '--base warm', '--env CI=1',
                      '--env=CI=1', '--pull tmp/x', '--include=tmp/x', '--unknown'):
            commands.extend((f'offbox run {flags} -- {live}', f'offbox run {flags} -- bash live.sh'))
        commands.extend((f'offbox run --step {shlex.quote(live)}',
                         f'offbox run --step={shlex.quote(live)} -- true'))
        for name in ('BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'PS4', 'IFS', 'PATH', 'CDPATH',
                     'HOME', 'PROMPT_COMMAND', 'GLOBIGNORE', 'BASH_XTRACEFD', 'BASH_FUNC_x',
                     'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'ZDOTDIR'):
            for wrapper in ('', 'env ', 'offbox run --bg -- '):
                commands.append(f'{wrapper}{name}=/tmp/x bash {target}')
            for separator in (' ', '='):
                commands.append(f'offbox run --env{separator}{name}=/tmp/x -- bash {target}')
        for value in ('$(mktemp -u)', '$(mktemp -d -u)', '$(mktemp -d >out)',
                      '$(mktemp -d <input)', '$(mktemp -d; echo /tmp)',
                      '$(mktemp -d "$HOME/x.XXXXXX")', '$(echo /tmp)', '`mktemp -d`', '$UNPROVED'):
            commands.append(f'X={value} bash {target}')
        for flag in ('--size', '--template', '--base', '--env', '--pull', '--include'):
            commands.extend((f'offbox run {flag} -- bash {target}',
                             f'offbox run {flag}= -- bash {target}'))
        for command in commands:
            with self.subTest(command=command):
                rule, reason = guard.classify_detail(command, str(self.root))
                if remote_only_offbox(command) and 'statev2' not in command:
                    # The fixture runs only on the box (#221).
                    self.assertIsNone(rule, reason)
                    continue
                self.assertIsNotNone(rule)
                self.assertTrue(reason)
                if rule == SCRIPT:
                    self.assertRegex(reason, r'\.sh:\d+')

    def test_recall94_offbox_payload_walker_fails_closed(self):
        for arguments in ('--size', '--size --', '--size=', '--bg=1 --', '--unknown --',
                          '--step echo --', '--step=echo --', '--env BASH_ENV=/tmp/x --'):
            words = ['offbox', 'run', *shlex.split(arguments)]
            with self.subTest(arguments=arguments):
                self.assertIsNone(guard._offbox_payload(words))
                if '--' in words:
                    self.assertEqual(guard._offbox_payload(words, known_only=False), words[words.index('--') + 1:])

    def test_recall94_fixture_invocation_rejects_shell_operators(self):
        target = self.recall94_fixture()
        for name in ('PATH', 'LD_PRELOAD'):
            for separator in (';', '; ', ' ; ', '\n', '&&', '&& ', '||', '|| ', '&', '& ', '|', '| '):
                command = f'X=1{separator}{name}=/tmp/x bash {target}'
                commands = (command,
                            f'offbox run --bg --no-fallback -- {command}',
                            f'X=1{separator}{name}=/tmp/x offbox run --bg -- bash {target}',
                            f'offbox run --bg -- {shlex.quote(command)}')
                for wrapped in commands:
                    with self.subTest(name=name, separator=separator, command=wrapped):
                        rule, reason = guard.classify_detail(wrapped, str(self.root))
                        if remote_only_offbox(wrapped):
                            self.assertIsNone(rule, reason)
                            continue
                        self.assertIsNotNone(rule)
                        self.assertTrue(reason)
        for operator in (';', ';;', ';&', ';;&', '\n', '&&', '||', '&', '|', '|&', '(', ')', '{', '}',
                         '<', '>', '<<', '>>', '<<<', '<>', '>&', '<&', '>|'):
            for command in (f'X=1{operator}Y=2 bash {target}',
                            f'offbox run --bg -- X=1{operator}Y=2 bash {target}'):
                with self.subTest(operator=operator, command=command):
                    self.assertEqual(guard._fixture_invocation(command), [])

    def test_recall94_fixture_invocation_keeps_quoted_punctuation_literal(self):
        target = self.recall94_fixture()
        for operator in (';', '&', '|', '&&', '||', '(', ')', '{', '}', '<', '>', '\n'):
            for quote in ("'", '"'):
                for value in (operator, '1' + operator + 'PATH=/tmp/x'):
                    assignment = f'X={quote}{value}{quote}'
                    for wrapper in ('', 'env ', 'offbox run --bg -- ', 'offbox run --env '):
                        command = f'{wrapper}{assignment} bash {target}'
                        if wrapper == 'offbox run --env ':
                            command = f'{wrapper}{assignment} -- bash {target}'
                        with self.subTest(operator=operator, quote=quote, command=command):
                            self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))
        for operator in (';', '&', '|', '(', ')', '{', '}', '<', '>'):
            assignment = f'X=1\\{operator}PATH=/tmp/x'
            for wrapper in ('', 'env ', 'offbox run --bg -- '):
                with self.subTest(operator=operator, wrapper=wrapper):
                    self.assertEqual(guard.classify_detail(f'{wrapper}{assignment} bash {target}', str(self.root)), (None, None))

    def test_recall94_fixture_invocation_boundary_newlines(self):
        target = self.recall94_fixture()
        for prefix in ('', '\n', '\n \t\n', '# comment\n'):
            for suffix in ('\n', '\n \t\n', ' # comment\n'):
                for wrapper in ('', 'X=1 ', 'X=$(mktemp -d) ', 'env X=1 ', 'offbox run --bg -- '):
                    command = f'{prefix}{wrapper}bash {target}{suffix}'
                    with self.subTest(prefix=prefix, suffix=suffix, wrapper=wrapper):
                        self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))
        for wrapper in ('', 'offbox run --bg -- '):
            command = f'\n{wrapper}X=1\nPATH=/tmp/x bash {target}\n'
            with self.subTest(wrapper=wrapper):
                rule, reason = guard.classify_detail(command, str(self.root))
                self.assertIsNotNone(rule)
                self.assertTrue(reason)

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
                            'offbox run -- bash ' + path, 'offbox run --bg -- bash ' + path):
                with self.subTest(case=label, command=command):
                    # --bg runs the fixture only on the box (#221).
                    self.assertEqual(self.classify(command), None if remote_only_offbox(command) else SCRIPT)
        self.write(path, original)
        for command in ('sed -i "s/mktemp/echo/g" ' + path + '; bash ' + path,
                        'BASH_ENV=/tmp/preload.sh bash ' + path,
                        'BASH_ENV=/tmp/preload.sh offbox run --bg -- bash ' + path):
            with self.subTest(command=command):
                self.assertEqual(self.classify(command), SCRIPT)
        # offbox can fall back to a local run, so its payload inherits the
        # caller's startup bindings however they were set. Such a binding may
        # also rebind offbox itself, so it voids the remote-only skip (#221).
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
            self.assertEqual(self.classify('offbox run -- bash ' + path), SCRIPT)
            # An exported local function never reaches a --bg run (#221).
            self.assertIsNone(self.classify('offbox run --bg -- bash ' + path))
        # The snapshot root repeats $T, so an inherited temp prefix with parent
        # segments (or one the script reassigns) must void the fixture proof.
        commands = ('bash ' + path, '/bin/bash ' + str(self.root / path), 'offbox run -- bash ' + path,
                    'offbox run --bg -- bash ' + path)
        for prefix in ('relative/tmp', '/tmp/../..', '/tmp/x/../../Users'):
            with patch.dict(os.environ, {'TMPDIR': prefix}):
                for command in commands:
                    with self.subTest(tmpdir=prefix, command=command):
                        self.assertEqual(self.classify(command), None if remote_only_offbox(command) else SCRIPT)
        self.write(path, 'TMPDIR=/tmp/../..\n' + original)
        for command in commands:
            with self.subTest(case='script-assigns-tmpdir', command=command):
                self.assertEqual(self.classify(command), None if remote_only_offbox(command) else SCRIPT)

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

    def test_repo_node_pin_node_path_parity(self):
        self.root = self.root.resolve()
        home, helper, environment = self.repo_node_pin()
        node = home / '.nvm/versions/node/v26.0.0/bin/node'
        node.chmod(0o700)
        script = self.write('repo/scripts/x.mjs', 'console.log(1);\n')
        repo = script.parent.parent
        (repo / 'package.json').write_text('{"engines":{"node":">=22"}}')
        unrelated = self.root / 'elsewhere'
        unrelated.mkdir()
        environment['PATH'] = str(node.parent) + os.pathsep + os.environ['PATH']
        with patch.dict(os.environ, environment):
            for git_kind in ('directory', 'file'):
                git = repo / '.git'
                git.mkdir() if git_kind == 'directory' else git.write_text('gitdir: /unused/worktree\n')
                for cwd in (repo, script.parent, unrelated):
                    for executable in (str(node), 'node'):
                        for mode in ('--check ', ''):
                            for chain in ('{}', '{} && git diff -- package.json'):
                                for operand in (str(script), os.path.relpath(script, cwd)):
                                    command = chain.format(shlex.quote(executable) + ' ' + mode + shlex.quote(operand))
                                    with self.subTest(git=git_kind, cwd=cwd, command=command):
                                        self.assertEqual(guard.classify_detail(command, str(cwd)), (None, None))
                git.rmdir() if git.is_dir() else git.unlink()

    def test_repo_node_pin_node_startup_mutations_stay_denied(self):
        self.root = self.root.resolve()
        home, helper, environment = self.repo_node_pin()
        node = home / '.nvm/versions/node/v26.0.0/bin/node'
        node.chmod(0o700)
        script = self.write('scripts/x.mjs', 'console.log(1);\n')
        (self.root / '.git').write_text('gitdir: /unused/worktree\n')
        (self.root / 'package.json').write_text('{}')
        environment['PATH'] = str(node.parent) + os.pathsep + os.environ['PATH']
        targets = [node, node.parent / 'cat', helper / 'init.sh',
                   home / '.safe-chain/scripts/init-posix.sh', self.root / 'package.json']
        with patch.dict(os.environ, environment):
            for executable in (str(node), 'node'):
                for mode in ('--check ', ''):
                    check = shlex.quote(executable) + ' ' + mode + shlex.quote(str(script))
                    for target in targets:
                        for writer in ('cp /untrusted ' + shlex.quote(str(target)) + '; ',
                                       "cat > " + shlex.quote(str(target)) + " <<'EOF'\nchanged\nEOF\n"):
                            with self.subTest(target=target, check=check, writer=writer):
                                prepared = self.heredoc(str(script), 'console.log(1);') if not mode else ''
                                rule, reason = guard.classify_detail(prepared + writer + check, str(self.root))
                                self.assertEqual(rule, UNRESOLVED)
                                self.assertIn('startup', reason)
                    for prefix in ('NODE_OPTIONS=--require=/untrusted ', 'BASH_ENV=' + environment['BASH_ENV'] + ' '):
                        with self.subTest(prefix=prefix, check=check):
                            prepared = self.heredoc(str(script), 'console.log(1);') if not mode else ''
                            self.assertEqual(self.classify(prepared + prefix + check), UNRESOLVED)
            with patch.dict(os.environ, {'NODE_OPTIONS': '--require=/untrusted'}):
                self.assertEqual(self.classify(str(node) + ' --check ' + str(script)), UNRESOLVED)

    def test_repo_node_pin_startup_refusal_names_input(self):
        self.root = self.root.resolve()
        home, helper, environment = self.repo_node_pin()
        node = home / '.nvm/versions/node/v26.0.0/bin/node'
        node.chmod(0o700)
        script = self.write('scripts/x.mjs', 'console.log(1);\n')
        command = str(node) + ' --check ' + str(script)

        def refused(extra, expected):
            with patch.dict(os.environ, {**environment, **extra}):
                rule, reason = guard.classify_detail(command, str(self.root))
                self.assertEqual(rule, UNRESOLVED)
                self.assertIn(expected, reason)
                message = guard.refusal_reason(rule, reason, str(self.root))
                self.assertIn(expected, message)
                self.assertNotIn('literal absolute script path', message)

        refused({'PATH': '.:' + os.environ['PATH']}, "PATH entry '.' is not absolute")
        refused({'PYTHONPATH': '/untrusted'}, 'PYTHONPATH')
        shadow = node.parent / 'cat'
        shadow.write_text('')
        refused({}, str(shadow) + ' shadows trusted cat')
        shadow.unlink()
        package = self.root / 'package.json'
        os.mkfifo(package)
        refused({}, str(package) + ' unsafe')
        package.unlink()
        (helper / 'init.sh').write_text('changed')
        refused({}, str(helper / 'init.sh') + ' hash does not match reviewed bytes')

    def test_repo_node_pin_predecessors_remain_denied(self):
        self.root = self.root.resolve()
        home, helper, environment = self.repo_node_pin()
        node = home / '.nvm/versions/node/v26.0.0/bin/node'
        node.chmod(0o700)
        python = self.write('unproved-bin/python3', '')
        python.chmod(0o700)
        environment['PATH'] = os.pathsep.join((str(node.parent), str(python.parent), os.environ['PATH']))
        (self.root / '.git').write_text('gitdir: /unused/worktree\n')
        (self.root / 'package.json').write_text('{}')
        fixtures = Path(__file__).with_name('fixtures') / 'node-startup'
        with patch.dict(os.environ, environment):
            for row, predecessor in ((173, 'preceding python3 at line 1: python3: executable provenance'),
                                     (775, 'preceding git at line 1: git: startup configuration unproved')):
                command = (fixtures / f'crpko4207-row{row}.sh').read_text()
                with self.subTest(row=row):
                    rule, reason = guard.classify_detail(command, str(self.root))
                    self.assertEqual(rule, UNRESOLVED)
                    self.assertIn('startup input /opt/homebrew/bin/python3', reason)
                    self.assertIn(predecessor, reason)
                    message = guard.refusal_reason(rule, reason, str(self.root))
                    self.assertIn(predecessor, message)
                    self.assertNotIn('literal absolute script path', message)

    def test_repo_node_pin_bindings_survive_offbox_boundary(self):
        self.write_plain_subpath_fixture()
        home, helper, environment = self.repo_node_pin()
        (self.root / 'package.json').write_text('{}')
        evil = self.write('tmp/evil.sh', 'printf bad > "$HOME/.robob/userdata/statev2.sqlite"\n')
        bindings = {
            'ROBOB_REPO_NODE_PYTHON': str(evil),
            'ROBOB_REPO_NODE_HELPER': str(helper),
            'ROBOB_REPO_PREVIOUS_BASH_ENV': environment['BASH_ENV'],
            'ROBOB_REPO_NODE': '/unproved/node',
            'ROBOB_REPO_PNPM_CLI': '/unproved/pnpm',
            '_repo_node_added_node': '/usr/bin',
            '_repo_node_hooked': '1',
            '_repo_node_busy': '0',
            '_repo_node_seen_pwd': str(self.root),
            'COREPACK_HOME': '/unproved/corepack',
            'NVM_DIR': str(home / '.nvm'),
            'CDPATH': '/unproved',
            'HOME': '/unproved',
            'BASH_ENV': environment['BASH_ENV'],
        }
        with patch.dict(os.environ, environment):
            for payload in ('offbox run -- bash tmp/fixture.sh', 'offbox run --bg -- bash tmp/fixture.sh'):
                self.assertIsNone(self.classify(payload))
                for name, value in bindings.items():
                    assignment = name + '=' + shlex.quote(value)
                    for prefix in (assignment + ' ', 'env ' + assignment + ' ', 'export ' + assignment + '; ',
                                   'unset ' + name + '; '):
                        with self.subTest(name=name, prefix=prefix, payload=payload):
                            # A caller-side binding keeps even a remote-only payload checked.
                            self.assertIsNotNone(self.classify(prefix + payload))
            for prefix in ('NODE_OPTIONS=--require=/unproved ', 'env NODE_OPTIONS=--require=/unproved ',
                           'export NODE_OPTIONS=--require=/unproved; '):
                with self.subTest(prefix=prefix):
                    self.assertIsNotNone(self.classify(prefix + 'offbox run -- node --check tmp/x.mjs'))

    def test_repo_node_pin_unset_bindings_keep_startup_unproved(self):
        self.root = self.root.resolve()
        home, helper, environment = self.repo_node_pin()
        node = home / '.nvm/versions/node/v26.0.0/bin/node'
        node.chmod(0o700)
        script = self.write('scripts/x.mjs', 'console.log(1);\n')
        (self.root / 'package.json').write_text('{}')
        (self.root / '.nvmrc').write_text('default\n')
        (self.root / '.git').write_text('gitdir: /unused/worktree\n')
        (self.root / 'sub').mkdir()
        marker = self.write('marker/input', '{}')
        alias = home / '.nvm/alias/default'
        alias.parent.mkdir()
        os.link(marker, alias)
        safe_nvm = self.root / 'safe-nvm'
        (safe_nvm / 'alias').mkdir(parents=True)
        (safe_nvm / 'alias/default').write_text('v26.0.0\n')
        environment['NVM_DIR'] = str(safe_nvm)
        environment['PATH'] = str(node.parent) + os.pathsep + os.environ['PATH']
        self.assertFalse(guard._repo_node_pin_input_safe(alias))
        self.write_plain_subpath_fixture()
        names = ('PATH', 'IFS', 'HOME', 'BASH_ENV', 'ENV', 'BASHOPTS', 'SHELLOPTS', 'CDPATH',
                 'ZDOTDIR', 'NODE_OPTIONS', 'NVM_DIR', 'COREPACK_HOME', 'ROBOB_REPO_NODE_HELPER',
                 'ROBOB_REPO_NODE_PYTHON', 'ROBOB_REPO_PREVIOUS_BASH_ENV', 'ROBOB_REPO_NODE',
                 'ROBOB_REPO_PNPM_CLI', '_repo_node_added_node', '_repo_node_hooked',
                 '_repo_node_busy', '_repo_node_seen_pwd', 'PYTHONPATH', 'DYLD_INSERT_LIBRARIES')
        with patch.dict(os.environ, environment):
            for executable in ('node', str(node)):
                for operand in ('../scripts/x.mjs', str(script)):
                    check = 'cd sub; ' + shlex.quote(executable) + ' --check ' + shlex.quote(operand)
                    with self.subTest(executable=executable, operand=operand):
                        self.assertEqual(guard.classify_detail(check, str(self.root)), (None, None))
                        self.assertIsNone(self.classify('unset UNUSED; ' + check))
                        rule, cause = guard.classify_detail('unset NVM_DIR; ' + check, str(self.root))
                        self.assertEqual(rule, UNRESOLVED, cause)
                        self.assertIn('NVM_DIR unset at line 1', cause)
            check = 'node --check scripts/x.mjs'
            for name in names:
                with self.subTest(name=name):
                    rule, cause = guard.classify_detail('unset ' + name + '; ' + check, str(self.root))
                    self.assertEqual(rule, UNRESOLVED, cause)
                    self.assertIn(name + ' unset at line 1', cause)
                    self.assertNotIn('literal absolute script path', guard.refusal_reason(rule, cause, str(self.root)))
            for wrapper in ('offbox run -- ', 'offbox run --bg -- '):
                fixture = 'bash tmp/fixture.sh'
                self.assertIsNone(self.classify(wrapper + fixture))
                for name in names:
                    for command in ('unset ' + name + '; ' + wrapper + fixture,
                                    wrapper + shlex.quote('unset ' + name + '; ' + fixture)):
                        with self.subTest(name=name, command=command):
                            self.assertEqual(self.classify(command), SCRIPT)
                    retained = self.heredoc('tmp/retained.sh', 'echo ok')
                    command = retained + 'unset ' + name + '; ' + wrapper + 'bash tmp/retained.sh'
                    with self.subTest(name=name, retained=True, wrapper=wrapper):
                        rule, cause = guard.classify_detail(command, str(self.root))
                        self.assertEqual(rule, UNRESOLVED, cause)
                        self.assertIn(name + ' unset at line ', cause)
            for prefix in ('unset UNUSED NVM_DIR; ', 'unset NVM_DIR UNUSED; ', 'command unset NVM_DIR; ',
                           'builtin unset NVM_DIR; ', 'unset -- NVM_DIR; ', 'unset -v NVM_DIR; ',
                           'unset -v -- NVM_DIR; ', 'unset -n NVM_DIR; ', 'env -u NVM_DIR ',
                           'env -uNVM_DIR ', 'env --unset NVM_DIR ', 'env --unset=NVM_DIR '):
                for wrapper in ('', 'offbox run -- ', 'offbox run --bg -- '):
                    with self.subTest(prefix=prefix, wrapper=wrapper):
                        self.assertEqual(self.classify(prefix + wrapper + check), UNRESOLVED)

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

    def test_inherited_repo_node_pin_safe_chain_bytes(self):
        import hashlib
        self.assertEqual(hashlib.sha256(SAFE_CHAIN_INIT_POSIX.encode()).hexdigest(),
                         guard.REPO_NODE_PIN_SAFE_CHAIN_SHA256)
        commands = self.write_plain_subpath_fixture()
        home, helper, environment = self.repo_node_pin()
        environment['PATH'] = os.pathsep.join(entry for entry in os.get_exec_path() if os.path.isabs(entry))
        startup = home / '.safe-chain/scripts/init-posix.sh'
        for label, body, expected in (
            ('absent', None, None),
            ('matching', SAFE_CHAIN_INIT_POSIX, None),
            ('changed', SAFE_CHAIN_INIT_POSIX + '\n# changed\n', UNRESOLVED),
            ('other', 'echo unexpected\n', UNRESOLVED),
        ):
            if body is not None:
                startup.parent.mkdir(parents=True, exist_ok=True)
                startup.write_text(body)
            with patch.dict(os.environ, environment):
                for command in commands:
                    with self.subTest(case=label, command=command):
                        rule, reason = guard.classify_detail(command, str(self.root))
                        self.assertEqual(rule, expected)
                        if expected is not None:
                            self.assertIn(str(startup), reason)
                            self.assertIn('REPO_NODE_PIN_SAFE_CHAIN_SHA256', reason)
        startup.write_text(SAFE_CHAIN_INIT_POSIX)
        original_open = open
        for target in (Path(LIVE), Path.home() / '.robob/userdata/archive.sqlite',
                       self.write('outside-safe-chain.sh', SAFE_CHAIN_INIT_POSIX)):
            startup.unlink()
            startup.symlink_to(target)

            def checked_open(path, *args, **kwargs):
                if Path(path) == startup:
                    raise AssertionError('must reject startup target before opening it')
                return original_open(path, *args, **kwargs)

            with self.subTest(startup_target=str(target)), patch.dict(os.environ, environment), patch('builtins.open', side_effect=checked_open):
                rule, reason = guard.classify_detail(commands[0], str(self.root))
                self.assertEqual(rule, UNRESOLVED)
                self.assertIn('REPO_NODE_PIN_SAFE_CHAIN_SHA256', reason)
        startup.unlink()
        startup.write_text(SAFE_CHAIN_INIT_POSIX)
        with patch.dict(os.environ, environment):
            for writer in (self.heredoc(str(startup), 'echo changed'),
                           'cp /tmp/other.sh ' + str(startup) + '; '):
                with self.subTest(writer=writer):
                    self.assertIsNotNone(self.classify(writer + commands[0]))
            # Startup executes dirname and then adds its bin directory. Check
            # both dependencies against shadowing in either search location.
            for tool in ('cat', 'dirname'):
                for folder in (home / 'shadow-bin', home / '.safe-chain/bin'):
                    shadow = folder / tool
                    shadow.parent.mkdir(parents=True, exist_ok=True)
                    shadow.write_text('#!/bin/sh\n')
                    shadow.chmod(0o755)
                    with self.subTest(tool=tool, folder=str(folder)), patch.dict(os.environ, {'PATH': str(folder) + os.pathsep + environment['PATH']}):
                        self.assertEqual(self.classify(commands[0]), SCRIPT)
                    shadow.unlink()
        original = (helper / 'init.sh').read_text()
        (helper / 'init.sh').write_text(original.replace('init-posix.sh', 'other.sh'))
        with patch.dict(os.environ, environment):
            self.assertEqual(self.classify(commands[0]), SCRIPT)


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

    def fixture_wrapper_commands(self):
        script, root = 'tmp/fixture.sh', str(self.root)
        return (
            f'bash {script} | tail -3', f'bash {script} 2>&1 | tail -n 3', f'bash {script} | tail -n3',
            f'bash {script} 2>&1 | head -5', f'bash {script} | grep -v noise',
            f'bash {script} 2>&1 | grep -Ei "pass|fail" | tail -5', f"bash {script} | grep -E 'ok|FAIL'",
            f'bash {script}; echo "exit=$?"', f'bash {script}; echo $?', f'bash {script} && echo ok',
            f'bash {script} 2>&1 | tail -5; echo "exit=$?"',
            f'cd {root} && bash {script}', f'cd {root} && bash {script} 2>&1 | tail -3',
            'cd ./tmp && bash fixture.sh | tail -3', f'cd ./tmp && bash {root}/{script} && echo ok',
            # Quoted punctuation keeps a whole pattern literal, globs included.
            f'bash {script} 2>&1 | grep -E "PASS|FAIL.*" | tail -5', f"bash {script} | grep -v '[x]|y*'",
            f"bash {script} | grep 'files/*'", f'bash {script} | grep "files/[ab]"',
            f'/bin/bash {root}/{script} 2>&1 | tail -3',
            f'offbox run -- bash {script} 2>&1 | tail -3', f'offbox run --bg -- bash {script}; echo $?',
        )

    def test_fixture_wrappers_keep_fixture_proof(self):
        # Agents pipe test runs into tail or cd first; the run is unchanged.
        self.write_plain_subpath_fixture()
        original = (self.root / 'tmp/fixture.sh').read_text()
        _, _, inherited = self.repo_node_pin()
        for label, environment in (('no-bash-env', {}), ('inherited-bash-env', inherited)):
            with patch.dict(os.environ, environment):
                self.write('tmp/fixture.sh', original)
                for command in self.fixture_wrapper_commands():
                    with self.subTest(case=label, command=command):
                        self.assertIsNone(self.classify(command))
                # The same wrappers never excuse a fixture that reads a live path,
                # unless only the box runs it; an inherited BASH_ENV keeps even that checked.
                self.write('tmp/fixture.sh', original + '\ncat "' + LIVE + '"\n')
                for command in self.fixture_wrapper_commands():
                    remote = label == 'no-bash-env' and command.startswith('offbox run --bg ')
                    with self.subTest(case=label + ':live-fixture', command=command):
                        self.assertEqual(self.classify(command), None if remote else SCRIPT)

    def test_fixture_wrapper_refusals(self):
        self.write_plain_subpath_fixture()
        _, _, inherited = self.repo_node_pin()
        run, root = 'bash tmp/fixture.sh', str(self.root)
        live = '~/' + '.ro' + 'bob/userdata/' + 'state' + 'v2.sqlite'
        rows = [
            # Other stages, redirects, substitutions, background, statements.
            run + ' | tee out', run + ' | sh', run + ' | xargs cat', run + ' > out', run + ' 2>&1 > out',
            run + ' | tail -3 > out 2>&1', run + ' | grep -f file', run + ' | grep --file=file x',
            run + ' | grep -e x', run + ' | grep -r x', run + ' | grep x file', run + ' | tail 3', run + ' | tail -f',
            run + ' | head -c 5', run + ' | tail -3 | head -2 | grep x', run + ' |& tail -3', run + ' 2 >&1 | tail',
            run + ' x | tail -3', run + ' &', run + ' | tail -3 &', run + ' | grep &', run + ' | grep -v ;',
            '(' + run + ') | tail -3', run + ' || echo ok', run + '; echo ok', run + '; echo $HOME',
            run + ' && echo $(id)', run + ' | grep "$(id)"', run + ' | grep "`id`"', run + ' | grep "$X"',
            run + ' | grep "a|$X"', run + ' $(id) | tail -3',
            run + ' | tail -3 # comment', run + ' | tail -3\nls', run + ' | tail -3; ls', 'ls; ' + run, 'ls tmp/; ' + run,
            # Only one literal, anchored cd.
            'cd "$X" && ' + run, 'cd - && ' + run, 'cd tmp && bash fixture.sh',
            'cd ' + root + ' && cd ' + root + ' && ' + run, 'cd /tm* && ' + run, 'CDPATH=' + root + ' cd ./tmp && bash fixture.sh',
            'cd ./tmp; bash fixture.sh', 'pushd ' + root + ' && ' + run, 'cd ' + root + ' && offbox run -- ' + run,
            # `..` in a cd target: Bash's logical cd and the resolved path differ.
            'cd ../' + self.root.name + ' && ' + run, 'cd ./tmp/.. && ' + run, 'cd ' + root + '/tmp/.. && ' + run,
            # Unquoted expansion turns one pattern into pattern + file operands.
            run + ' | grep files/*', run + ' 2>&1 | grep -v files/? | tail -3', run + ' | grep files/[ab]',
            run + ' | grep {x,files/b}', run + ' | grep ~', run + ' | grep -E files/*',
            "bash tmp/fixture.s? | tail -3", "bash tmp/{fixture.sh,x} | tail -3",
            # Quoting only part of the pattern leaves the rest to expand.
            run + ' | grep files/"*"x*', run + " | grep 'a'\"b\"*",
            # A live read in a later stage is refused on its own.
            run + ' | grep x ' + live, run + ' | tail -3; cat ' + live,
        ]
        # The glob's second match is a protected-path marker.
        marker = self.write('marker/.robob/userdata/statev2.sqlite', '{}')
        self.write('files/a', '')
        (self.root / 'files/b').symlink_to(marker)
        for label, environment in (('no-bash-env', {}), ('inherited-bash-env', inherited)):
            with patch.dict(os.environ, environment):
                for command in rows:
                    with self.subTest(case=label, command=command):
                        self.assertIsNotNone(self.classify(command))
        # `~` follows HOME; point it at the fixture's parent so the cd lands.
        tilde = 'cd ~/' + self.root.name + ' && ' + run
        with patch.dict(os.environ, {'HOME': str(self.root.parent)}):
            self.assertEqual(self.classify(tilde), SCRIPT)
        rows.append(tilde)
        # The grammar itself rejects each row, except where only the run
        # check refuses: an extra script argument, and a cd before offbox,
        # whose remote cwd the proof does not follow.
        passes_grammar = {run + ' x | tail -3': (None, ['bash', 'tmp/fixture.sh', 'x']),
                          'cd ' + root + ' && offbox run -- ' + run: (root, ['offbox', 'run', '--', 'bash', 'tmp/fixture.sh'])}
        for command in rows + ['$(echo bash) tmp/fixture.sh | tail -3']:
            with self.subTest(grammar=command):
                self.assertEqual(guard._fixture_wrapped_invocation(command), passes_grammar.get(command))

    def test_fixture_wrapper_cd_reproves_selector_inputs(self):
        # A cd moves the selector walk; both the target and the caller's
        # starting cwd must be clean.
        self.write_plain_subpath_fixture()
        _, _, environment = self.repo_node_pin()
        marker = self.write('marker/.robob/userdata/statev2.sqlite', '{}')
        for directory in ('good', 'bad'):
            (self.root / directory).mkdir()
        (self.root / 'bad/.nvmrc').symlink_to(marker)
        good, bad = str(self.root / 'good'), str(self.root / 'bad')
        with patch.dict(os.environ, environment):
            self.assertIsNone(guard.classify(f'cd {good} && bash ../tmp/fixture.sh | tail -3', str(self.root)))
            self.assertEqual(guard.classify(f'cd {bad} && bash ../tmp/fixture.sh | tail -3', str(self.root)), SCRIPT)
            self.assertEqual(guard.classify(f'cd {good} && bash ../tmp/fixture.sh | tail -3', bad), SCRIPT)
            self.assertEqual(guard.classify('bash ../tmp/fixture.sh | tail -3', bad), SCRIPT)
        # Without BASH_ENV there is no selector, so the cd target is all that moves.
        self.assertIsNone(guard.classify(f'cd {good} && bash ../tmp/fixture.sh | tail -3', bad))

    def test_fixture_wrapper_cd_logical_parent(self):
        # Bash's logical cd resolves `alias/..` to start/bad, not the parent of
        # alias's physical target; start/bad's selector input must not be missed.
        self.write_plain_subpath_fixture()
        _, _, environment = self.repo_node_pin()
        marker = self.write('marker/.robob/userdata/statev2.sqlite', '{}')
        (self.root / 'physical/deep').mkdir(parents=True)
        (self.root / 'start/bad').mkdir(parents=True)
        (self.root / 'start/bad/alias').symlink_to(self.root / 'physical/deep')
        (self.root / 'start/bad/.nvmrc').symlink_to(marker)
        start, fixture = str(self.root / 'start'), str(self.root / 'tmp/fixture.sh')
        with patch.dict(os.environ, environment):
            for target in ('./bad/alias/..', start + '/bad/alias/..', './bad/alias/../alias/..'):
                with self.subTest(target=target):
                    self.assertEqual(guard.classify(f'cd {target} && bash {fixture} | tail -3', start), SCRIPT)
            # A symlinked target is walked on both its logical and physical chains.
            self.assertEqual(guard.classify(f'cd ./bad/alias && bash {fixture} | tail -3', start), SCRIPT)
            self.assertIsNone(guard.classify(f'cd {self.root}/physical/deep && bash {fixture} | tail -3', start))

    def test_fixture_wrapper_cd_logical_script_here(self):
        # A relative script's HERE cd ($0/..) also runs against the logical
        # $PWD: from start/parent/alias it reaches start/parent/other, not
        # physical/other.
        self.write_plain_subpath_fixture()
        source = (self.root / 'tmp/fixture.sh').read_text()
        _, _, environment = self.repo_node_pin()
        marker = self.write('marker/.robob/userdata/statev2.sqlite', '{}')
        self.write('physical/other/tests/fixture.sh', source)
        (self.root / 'physical/deep').mkdir(parents=True)
        (self.root / 'start/parent/other').mkdir(parents=True)
        (self.root / 'start/parent/alias').symlink_to(self.root / 'physical/deep')
        start = str(self.root / 'start')
        command = 'cd ./parent/alias && bash ../other/tests/fixture.sh | tail -3'
        with patch.dict(os.environ, environment):
            self.assertIsNone(guard.classify(command, start))
            (self.root / 'start/parent/other/.nvmrc').symlink_to(marker)
            self.assertEqual(guard.classify(command, start), SCRIPT)
            self.assertEqual(guard.classify(command.replace(' | tail -3', ''), start), SCRIPT)
        # Without BASH_ENV no selector runs, so the fixture proof stands.
        self.assertIsNone(guard.classify(command, start))

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
                            'offbox run -- bash tmp/fixture.sh', 'offbox run --bg -- bash tmp/fixture.sh'):
                with self.subTest(root=root, command=command):
                    self.assertEqual(self.classify(command), None if remote_only_offbox(command) else SCRIPT)

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
                            'offbox run -- bash tmp/fixture.sh', 'offbox run --bg -- bash tmp/fixture.sh'):
                with self.subTest(quote=quote, separator=separator, command=command):
                    self.assertEqual(self.classify(command), None if remote_only_offbox(command) else SCRIPT)

    def test_mktemp_fixture_tool_identity(self):
        backup = Path(__file__).resolve().parents[3] / 'integrations/memory-system/tests/test_backup_replica.sh'
        self.write('tmp/backup.sh', backup.read_text())
        for label, source, search_path, expected, shell in isolated_source_cases.fixture_tool_cases(self.root):
            self.write('tmp/fixture.sh', source)
            with self.subTest(case=label, path=search_path), patch.dict(os.environ, {'PATH':search_path}):
                assert_verdict(self, shell + ' tmp/fixture.sh', self.root, expected)
                if label.startswith('path-'):
                    assert_verdict(self, shell + ' tmp/backup.sh', self.root, expected)

    def test_backup_command_shapes_and_edited_copies(self):
        backup = Path(__file__).resolve().parents[3] / 'integrations/memory-system/tests/test_backup_replica.sh'
        commands, variants = isolated_source_cases.backup_cases(self.root, backup.read_text())
        self.write('sibling.sh', 'cat ~/.t3/userdata/statev2.sqlite')
        for variant, source, expected in variants:
            self.write('integrations/memory-system/tests/test_backup_replica.sh', source)
            for shape, command, cwd in commands:
                with self.subTest(variant=variant, shape=shape):
                    # `offbox run --remote --no-fallback` runs the copy only on the box.
                    self.assertEqual(guard.classify(command, str(cwd)), None if shape == 'offbox-options' else expected)

    def test_fixture_review_control_corpus(self):
        backup = Path(__file__).resolve().parents[3] / 'integrations/memory-system/tests/test_backup_replica.sh'
        for label, source, expected in isolated_source_cases.setup_control_cases(backup.read_text()):
            self.write('tmp/fixture.sh', source)
            for prefix in ('bash ', 'offbox run -- bash ', 'offbox run --remote --no-fallback -- bash '):
                with self.subTest(case=label, source=source, prefix=prefix):
                    # A remote-only run never executes the fixture here (#221).
                    self.assertEqual(self.classify(prefix + 'tmp/fixture.sh'),
                                     None if remote_only_offbox(prefix + 'tmp/fixture.sh') else expected)

    @unittest.skipUnless(Path('/opt/homebrew/opt/sqlite/bin/sqlite3').is_file(), 'requires fixture SQLite CLI')
    def test_safe_sqlite_dump_restore(self):
        command = ['/opt/homebrew/opt/sqlite/bin/sqlite3', '-safe', '-noinit', '--', ':memory:']
        dump = "CREATE TABLE scheduled_tasks(name); INSERT INTO scheduled_tasks VALUES ('it''s 7');\nCREATE TABLE ardud_mission_events(id); INSERT INTO ardud_mission_events VALUES ('m');"
        result = subprocess.run(command + [dump, 'SELECT name FROM scheduled_tasks', 'SELECT id FROM ardud_mission_events'], capture_output=True, text=True)
        if result.returncode and 'unknown option: -noinit' in result.stderr:
            self.skipTest('requires SQLite CLI with -noinit support')
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
        isolated_source_cases.write_migration_helpers(self.root)
        migrate = Path(__file__).resolve().parents[3] / 'apps/server/scripts/migrate-dev-db.ts'
        for label, source, expected in isolated_source_cases.migration_mutations(migrate.read_text()):
            self.write('apps/server/scripts/migrate-dev-db.ts', source)
            with self.subTest(case=label):
                self.assertEqual(self.classify('node apps/server/scripts/migrate-dev-db.ts --source /tmp/copy.sqlite --base-dir /tmp/dev-home'), expected)

    def test_heredoc_data_and_execution(self):
        body = "import hashlib, pathlib, subprocess\n# it's a diff check\nprint('ok')\n"
        self.table([
            (f"cat > tmp/x.py <<'EOF'\n{body}EOF\npython3 -I tmp/x.py", None),
            (f"cat > tmp/x.py <<'EOF'\n{body}EOF", None),
            (f"cat > x.sh <<'EOF'\nsqlite3 {LIVE}\nEOF", None),
            (f"cat > p.sh <<'EOF'\nsqlite3 {LIVE}\nEOF\nbash p.sh", SCRIPT),
            (f"cat > p.sh <<'EOF'\nsqlite3 {LIVE}\nEOF\noffbox run -- bash p.sh", SCRIPT),
            (f"cat >> p.sh <<'EOF'\nsqlite3 {LIVE}\nEOF\nbash p.sh", SCRIPT),
            (f"tee p.py <<'EOF'\nopen({LIVE!r}).read()\nEOF\npython3 -I p.py", SCRIPT),
            (f"node - <<'JS'\nrequire('fs').readFileSync({LIVE!r})\nJS", READ),
            ("bash <<'EOF'\npython3 -I $X\nEOF", UNRESOLVED),
            (f"bash <<EOF\nsqlite3 {LIVE} .tables\nEOF", READ),
            (f"python3 -I - <<'EOF'\nimport sqlite3; sqlite3.connect({LIVE!r})\nEOF", READ),
            ("cat > p.py <<'EOF'\npython3 -I $X", UNRESOLVED),
            ("cat <<-EOF\n\tpython3 -I $X\n\tEOF", None),
            ("cat <<A <<'B'\npython3 -I $X\nA\nbash $Y\nB", None),
            ("cat <<'A' > tmp/a; cat <<'B' > tmp/b\npython3 -I $X\nA\nbash $Y\nB", None),
            (f"cat <<A > p.txt; bash <<A\nprint('safe')\nA\nsqlite3 {LIVE}\nA", READ),
            (f"bash <<A; cat <<A > p.txt\nsqlite3 {LIVE}\nA\nprint('safe')\nA", READ),
            (f"cat > p.txt <<EOF\n$(sqlite3 {LIVE} .tables)\nEOF", READ),
            (f"cat > p.txt <<EOF\n`sqlite3 {LIVE} .tables`\nEOF", READ),
            (f"cat > p.txt <<'EOF'\n$(sqlite3 {LIVE} .tables)\nEOF", None),
            ("cat > p.py <<PY-SCRIPT\nprint('safe')\nPY-SCRIPT\npython3 -I p.py", None),
            ("cat > p.py <<EOF_1.2\nprint('safe')\nEOF_1.2\npython3 -I p.py", None),
            (f"python3 -I tmp/t.py <<'TXT'\n{LIVE}\nTXT", None),
            (f"python3 -I -u tmp/t.py <<'TXT'\n{LIVE}\nTXT", None),
            (f"python3 -I -X dev - <<'PY'\nopen({LIVE!r}).read()\nPY", READ),
            (f"python3 -I -W ignore - <<'PY'\nopen({LIVE!r}).read()\nPY", READ),
            (f"python3 -I --check-hash-based-pycs always - <<'PY'\nopen({LIVE!r}).read()\nPY", READ),
            (f"python3 -I -X dev tmp/t.py <<'TXT'\n{LIVE}\nTXT", None),
        ])
        overwrite = f"cat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\npython3 -I tmp/live.py"
        self.assertIsNone(self.classify(overwrite))
        self.assertEqual(self.classify(overwrite.replace("> tmp/live.py", ">> tmp/live.py")), SCRIPT)
        self.assertIsNone(self.classify(f"cat > p.py <<'A'\nopen({LIVE!r})\nA\ncat > p.py <<'B'\nprint('safe')\nB\npython3 -I p.py"))
        for start, end in [("if false; then", "fi"), ("while false; do", "done"), ("for f in a b; do", "done"), ("if false; then bash <<'SH'", "SH\nfi"), ("if false; then {", "}; fi"), ("false && {", "}"), ("true || (", ")")]:
            with self.subTest(start=start):
                self.assertEqual(self.classify(f"{start}\ncat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\n{end}\npython3 -I tmp/live.py"), SCRIPT)
        for prefix in ("false && ", "true || "):
            self.assertEqual(self.classify(f"{prefix}cat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\npython3 -I tmp/live.py"), SCRIPT)
        for start, end in [("{", "} &"), ("(", ") &"), ("{", "} | cat"), ("{", "} >/dev/null &"), ("(", ") 2>/dev/null &"), ("{", "} >/dev/null 2>&1 &"), ("{", "} &>/dev/null &"), ("{", "} >/dev/null | cat")]:
            self.assertEqual(self.classify(f"{start}\ncat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\n{end}\npython3 -I tmp/live.py"), SCRIPT)
        for start, end in [("{", "}"), ("(", ")"), ("{", "} >/dev/null"), ("{", "} >/dev/null 2>&1")]:
            self.assertIsNone(self.classify(f"{start}\ncat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\n{end}\npython3 -I tmp/live.py"))
        for target in ("'&'", "'|'", "'&>'", "'&&'", "'&&&'", "'>'", "'&''>'", "\"|\"", "'a&b'", "'__guard_quoted_0__'", "'<<'", "'>>'"):
            for end, expected in [(" &", SCRIPT), (" | cat", SCRIPT), ("", None)]:
                with self.subTest(target=target, end=end):
                    command = f"# it's a quoted target\n{{\ncat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\n}} > {target}{end}\npython3 -I tmp/live.py"
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
            (f'env -S \'DB={LIVE} cat "$DB"\'', UNRESOLVED),
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

    @trusted_node_test
    def test_reporter_commands(self):
        fixtures = Path(__file__).with_name("fixtures")
        manifest = json.loads((fixtures / "manifest.json").read_text())
        for filename in manifest:
            if manifest[filename]["kind"] == "codex-code-mode":
                continue
            with self.subTest(fixture=filename):
                command = (fixtures / filename).read_text()
                if filename in UNPROVED_REPORTERS:
                    rule, cause = guard.classify_detail(command, str(self.root))
                    self.assertEqual(rule, UNRESOLVED, cause)
                    self.assertIn(UNPROVED_REPORTERS[filename], cause)
                else:
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
                    self.assertEqual(guard.classify(command, info["cwd"]),
                                     UNRESOLVED if filename in UNPROVED_REPORTERS else None)
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
        self.assertEqual(guard.classify(command, cwd), UNRESOLVED)
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
                self.assertEqual(guard.classify(command, info["cwd"]), None if info["card"] == 3207 else UNRESOLVED)
                for extra, expected in [("", None), (f"\nopen({LIVE!r}).read()", SCRIPT)]:
                    wrapper = f"cat > {target} <<'GUARD_BODY'\n{body}{extra}\nGUARD_BODY\npython3 -I {target}"
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
            expected = UNRESOLVED if name in UNPROVED_REPORTERS else None
            self.assertEqual(guard.classify(command, cwd), expected)
            written_read = f"\ncat > tmp/read-live.py <<'GUARD_TWIN'\nopen({LIVE!r}).read()\nGUARD_TWIN\npython3 tmp/read-live.py"
            # An unproved earlier mutation can also make the appended cat
            # writer unreadable. Either precise read or unresolved must deny.
            self.assertIn(guard.classify(command + written_read, cwd), (expected or SCRIPT, UNRESOLVED))
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
            self.assertEqual(guard.classify(command, info["cwd"]), UNRESOLVED if info["card"] == 712 else None)
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
                    self.assertEqual(guard.classify(command, cwd), UNRESOLVED)
                    self.assertEqual(guard.classify(twin, cwd), SCRIPT)
            self.assertNotEqual(twin, command)
            self.assertEqual(guard.classify(twin, info["cwd"]), expected)
            for harness, tool, field in (("codex", "exec_command", "cmd"), ("codex", "Bash", "command"), ("claude", "Bash", "command")):
                for cmd, rule in ((command, UNRESOLVED if info["card"] == 712 else None), (twin, expected)):
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
            if name in UNPROVED_REPORTERS:
                rule, cause = guard.classify_detail(command, str(self.root))
                self.assertEqual(rule, UNRESOLVED, cause)
                self.assertIn(UNPROVED_REPORTERS[name], cause)
            else:
                self.assertEqual(guard.scripts_in(command, str(self.root)), [])
                self.assertIsNone(self.classify(command))

    def test_ovnfs_and_worktree_cwd_resolve_equally(self):
        for cwd in ("/Users/ardud/checkouts/guard-fixture", "/Users/ardud/.robob/worktrees/project/guard-fixture"):
            for body, expected in [("print('safe')", None), (f"open({LIVE!r}).read()", SCRIPT)]:
                command = f"cat > scripts/proof.py <<'EOF'\n{body}\nEOF\npython3 -I scripts/proof.py"
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
                self.assertEqual(self.classify(command), None if interpreter == 'bash' else UNRESOLVED)
        self.write("tmp/escrow-settlement/edit.py", (fixtures / "bodies/crpko-2743-edit.py").read_text())
        self.assertIsNone(self.classify((fixtures / "crpko-2743-edit.sh").read_text()))
        self.assertIsNone(self.classify("cat > testhost/.secrets/check.py <<'EOF'\nprint('safe fixture')\nEOF\npython3 -I testhost/.secrets/check.py ssh test"))

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
        setup, separator, remote = command.partition("\n offbox run ")
        self.assertIn("python3 - <<'PY'", setup)
        self.assertTrue(separator)
        wrapped = "offbox run " + remote
        self.assertIn('--remote', wrapped)
        # --remote never falls back (#221): the box runs check.sh, so its
        # content is not scanned. Without the flag it may run here.
        local = wrapped.replace('--remote ', '', 1)
        script = Path(os.path.realpath(self.root / "tmp/hc021d/check.sh"))
        self.write("tmp/hc021d/check.sh", "echo safe\n")
        self.assertIsNone(self.classify(wrapped))
        self.assertIsNone(self.classify(local))
        self.assertIn(script, guard.scripts_in(local, str(self.root)))
        self.write("tmp/hc021d/check.sh", "sqlite3 ~/.robob/userdata/statev2.sqlite .tables\n")
        self.assertIsNone(self.classify(wrapped))
        self.assertEqual(self.classify(local), SCRIPT)

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
            self.assertEqual(line["cause"], result["context"]["cause"][:240])
            self.assertIn('Accepted:', result['reason'])
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
            self.assertEqual(guard.classify(command, cwd), UNRESOLVED if manifest[name]["card"] == 165 else None)
            twin = command.replace("\nPY", f"\nopen({LIVE!r}).read()\nPY", 1)
            self.assertNotEqual(twin, command)
            for cmd, expected in ((command, UNRESOLVED if manifest[name]["card"] == 165 else None), (twin, READ if manifest[name]["card"] == 3060 else SCRIPT)):
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


class ConfigDirectoryDatabaseNamesTests(unittest.TestCase):
    IMPORTS = ('import { open } from "node:fs/promises";\nimport { homedir } from "node:os";\n'
               'let handle: Awaited<ReturnType<typeof open>> | undefined;\n')

    def setUp(self):
        clean = isolated_source_cases.fixture_environment_patch()
        clean.start()
        self.addCleanup(clean.stop)
        self.temp = tempfile.TemporaryDirectory(prefix='config-db-guard-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def deny_list(self, tool='"telegram-bridge"', parameter='item', names=None):
        names = names or '["credentials.env", "state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "state.sqlite-journal", "bridge.sock"]'
        return (f'const protectedPaths = {names}\n'
                f'  .map({parameter} => join(homedir(), ".config", {tool}, {parameter}));\n')

    def assert_source(self, body, expected=None, args=('notify --text x', '--help')):
        source = self.IMPORTS + body.rstrip() + '\n'
        script = self.root / 'cli.ts'
        script.write_text(source)
        for argv in args:
            with self.subTest(argv=argv):
                assert_verdict(self, f'bun {shlex.quote(str(script))} {argv}', self.root, expected)
        for command in ("node - <<'JS'\n" + source + 'JS',
                        'bash -c ' + shlex.quote("node - <<'JS'\n" + source + 'JS')):
            with self.subTest(command=command):
                assert_verdict(self, command, self.root, READ if expected else None)

    def test_bridge_deny_lists_with_open_import(self):
        self.assert_source(self.deny_list())
        self.assert_source(self.deny_list('"spectrum-bridge"', 'name'),
                           args=('send --text x', 'react --target X --kind like'))
        self.assert_source("// The bridge's own deny list.\n" + self.deny_list())

    def test_bridge_deny_lists_from_thread_roots(self):
        roots = ('/Users/ardud/.robob/imessage', '/Users/ardud/.robob/chats',
                 '/Users/ardud/.robob/scratch', '/Users/ardud/.robob/projects/personal-finance',
                 '/Users/ardud', '/Volumes/ExternalSSD/t3code-fork')
        script = self.root / 'cli.ts'
        for tool, parameter, args in (
            ('telegram-bridge', 'item', ('notify --text x', '--help')),
            ('spectrum-bridge', 'name', ('send --text x', 'react --target X --kind like')),
        ):
            source = self.IMPORTS + self.deny_list(json.dumps(tool), parameter)
            script.write_text(source)
            for cwd in roots:
                for argv in args:
                    with self.subTest(tool=tool, cwd=cwd, argv=argv):
                        self.assertEqual(guard.classify_detail(f'bun {shlex.quote(str(script))} {argv}', cwd),
                                         (None, None))
                with self.subTest(tool=tool, cwd=cwd, stdin=True):
                    self.assertEqual(guard.classify_detail("node - <<'JS'\n" + source + 'JS', cwd),
                                     (None, None))

    def test_bridge_deny_list_consumers(self):
        for tool in ('telegram-bridge', 'spectrum-bridge'):
            with self.subTest(tool=tool):
                self.assert_source('import { stat } from "node:fs/promises";\n'
                                   'const file = process.argv[2];\n' + self.deny_list(json.dumps(tool)) +
                                   'if (protectedPaths.includes(resolve(file))) throw Error("protected");\n'
                                   'for (const path of protectedPaths) {\n'
                                   '  const secret = await stat(path, { bigint: true });\n'
                                   '  if (secret.ino === 1n) throw Error("protected");\n}\n'
                                   'const unrelatedName = basename(file);\n')

    def test_config_names_rebased_under_unknown_directory(self):
        imports = ('import path from "node:path";\nimport { homedir } from "node:os";\n'
                   'const { DatabaseSync } = await import("node:sqlite");\n')
        operands = ('"/Users/x/.config/mytool/state.sqlite"',
                    '"~/.config/mytool/state.sqlite"',
                    'path.join(homedir(), ".config", "mytool", "state.sqlite")',
                    '["state.sqlite"].map(n => path.join(homedir(), ".config", "mytool", n))[0]')
        transforms = ('path.basename(foreign)', 'path.parse(foreign).base',
                      'foreign.split("/").pop()', 'foreign.slice(foreign.lastIndexOf("/") + 1)')
        with patch.dict(os.environ, {'D': '/Users/x/.robob/userdata'}):
            for operand in operands:
                for transform in transforms:
                    source = (imports + f'const foreign = {operand};\n'
                              f'new DatabaseSync(path.join(process.env.D, {transform}));\n')
                    script = self.root / 'rebase.mjs'
                    script.write_text(source)
                    stdin = "node - <<'JS'\n" + source + 'JS'
                    commands = (('node ' + shlex.quote(str(script)), SCRIPT),
                                ('env D=/Users/x/.robob/userdata node ' + shlex.quote(str(script)), SCRIPT),
                                (stdin, READ), ('bash -c ' + shlex.quote(stdin), READ))
                    for command, expected in commands:
                        with self.subTest(operand=operand, transform=transform, command=command):
                            assert_verdict(self, command, self.root, expected)
            for operand in operands:
                for use in ('new DatabaseSync(`${process.env.D}/${path.basename(foreign)}`);',
                            'eval("new DatabaseSync(path.join(process.env.D, path.basename(foreign)))");'):
                    source = imports + f'const foreign = {operand};\n' + use + '\n'
                    with self.subTest(operand=operand, use=use):
                        assert_verdict(self, "node - <<'JS'\n" + source + 'JS', self.root, READ)

    def test_config_deny_list_unknown_consumers(self):
        for consumer in (
            'const foreign = protectedPaths[0];',
            'const foreign = protectedPaths.at(0);',
            'const foreign = protectedPaths.map(path => basename(path));',
            'for (const path of protectedPaths) { new DatabaseSync(join(process.env.D, basename(path))); }',
            'const alias = protectedPaths; new DatabaseSync(join(process.env.D, basename(alias[0])));',
            'consume(protectedPaths);',
            'for (const path of protectedPaths) { consume(path); }',
            'for (const path of protectedPaths) { const alias = path; }',
        ):
            with self.subTest(consumer=consumer):
                self.assert_source('const { DatabaseSync } = await import("node:sqlite");\n' +
                                   self.deny_list() + consumer, SCRIPT)

    def test_config_deny_list_metadata_reader_binding(self):
        loop = 'for (const path of protectedPaths) { await stat(path); }\n'
        for declarations in (
            '',
            'const stat = value => new DatabaseSync(join(process.env.D, basename(value)));\n',
            'import { stat as other } from "node:fs/promises";\n',
            'import { stat } from "node:fs/promises"; function f(stat) { ' + loop + '}\n',
        ):
            with self.subTest(declarations=declarations):
                self.assert_source('const { DatabaseSync } = await import("node:sqlite");\n' +
                                   self.deny_list() + declarations + loop, SCRIPT)

    def assert_consumer_override(self, before, after):
        source = ('import path from "node:path";\nimport { homedir } from "node:os";\n'
                  'const { DatabaseSync } = await import("node:sqlite");\n' + before +
                  'const protectedPaths = ["state.sqlite"].map(n => path.join(homedir(), ".config", "mytool", n));\n' + after + '\n')
        script = self.root / 'override.mjs'
        script.write_text(source)
        stdin = "node - <<'JS'\n" + source + 'JS'
        with patch.dict(os.environ, {'D': '/Users/ardud/.robob/userdata'}):
            for command, expected in (
                ('node ' + shlex.quote(str(script)), SCRIPT),
                ('env D=/Users/ardud/.robob/userdata node ' + shlex.quote(str(script)), SCRIPT),
                ('env D=/Users/ardud/.robob/userdata ' + stdin, READ),
                ('env D=/Users/ardud/.robob/userdata bash -c ' + shlex.quote(stdin), READ),
            ):
                with self.subTest(command=command):
                    assert_verdict(self, command, self.root, expected)

    def test_config_deny_list_overridden_membership(self):
        for receiver in ('Array.prototype', 'Array["prototype"]', 'Object.getPrototypeOf([])'):
            with self.subTest(receiver=receiver):
                self.assert_consumer_override(receiver + '.includes = function () {\n'
                                              '  new DatabaseSync(path.join(process.env.D, path.basename(this[0])));\n'
                                              '  return false;\n};\n',
                                              'if (protectedPaths.includes("unused")) throw Error("protected");')

    def test_config_deny_list_commented_metadata_import(self):
        for fake_import in ('/* import { stat } from "node:fs/promises"; */\n',
                            '// import { stat } from "node:fs/promises";\n',
                            'const text = \'import { stat } from "node:fs/promises";\';\n'):
            with self.subTest(fake_import=fake_import):
                self.assert_consumer_override(fake_import +
                                              'globalThis.stat = value => new DatabaseSync(path.join(process.env.D, path.basename(value)));\n',
                                              'for (const file of protectedPaths) { await stat(file); }')

    def test_direct_config_database_operands(self):
        for home in ('homedir()', 'os.homedir()'):
            for join in ('join', 'path.join', 'resolve'):
                for quote in ('"', "'"):
                    for suffix in ('', '-wal', '-shm', '-journal'):
                        with self.subTest(home=home, join=join, quote=quote, suffix=suffix):
                            self.assert_source(f'const p = {join}({home}, {quote}.config{quote}, '
                                               f'{quote}mytool{quote}, {quote}state.sqlite{suffix}{quote});')
        for path in ('~/.config/mytool/state.sqlite', '/Users/x/.config/mytool/state.sqlite-wal'):
            for quote in ('"', "'"):
                with self.subTest(path=path, quote=quote):
                    self.assert_source(f'const p = {quote}{path}{quote};')

    def test_reserved_tools_are_not_discharged(self):
        for tool in ('robob', 't3', 'opencode', 'T3Code', 'robob-data', 'opencode-data'):
            with self.subTest(tool=tool):
                self.assert_source(self.deny_list(json.dumps(tool)), SCRIPT)
                self.assert_source(f'const p = join(homedir(), ".config", "{tool}", "state.sqlite");', SCRIPT)
                self.assert_source(f'const p = "~/.config/{tool}/state.sqlite"; const root = ".robob";', SCRIPT)

    def test_nonliteral_and_unconfined_names_are_not_discharged(self):
        for body in (
            self.deny_list('dir'), self.deny_list('`my${tool}`'),
            self.deny_list('"../mytool"'), self.deny_list('".."'), self.deny_list('"my*tool"'),
            self.deny_list(names='["../state.sqlite"]'),
            self.deny_list(names='[`state.sqlite${suffix}`]'),
            self.deny_list(names='["state.sqlite", "../state.sqlite"]'),
            self.deny_list(names='["prefix \'state.sqlite\' suffix"]'),
            'const p = join(homedir(), ".config", dir, "state.sqlite");',
            'const p = join(homedir(), ".config", "mytool", `state.sqlite${suffix}`);',
            'const p = join(homedir(), ".config", "mytool", "../state.sqlite");',
            'const p = `${h}/.config/mytool/state.sqlite`;',
            'const p = `~/.config/mytool/state.sqlite`;',
            'const p = "/Users/../x/.config/mytool/state.sqlite";',
            'const p = "~/.config/mytool/state.sqlite?mode=ro";',
            'const p = "~/.config/mytool/state.sqlite\\x";',
            'const p = "~/.config/mytool/state.sqlite*";',
            'const p = "~/.config/${tool}/state.sqlite";',
            'const names = ["state.sqlite"];\nnames.map(n => join(homedir(), ".config", "mytool", n));',
            '["state.sqlite"].map(n => join(homedir(), ".config", "mytool", other));',
            '`join(homedir(), ".config", "mytool", "state.sqlite")`;',
        ):
            with self.subTest(body=body):
                self.assert_source(body, SCRIPT)

    def test_safe_deny_list_does_not_hide_another_database(self):
        for body in (
            'const n = "state.sqlite"; join(homedir(), ".robob", "userdata", n);',
            'const p = join(homedir(), ".t3/userdata", "state.sqlite");',
            'const p = join(homedir(), ".config", dir, "state.sqlite");',
            'const p = "/Users/x/.robob/userdata/statev2.sqlite";',
        ):
            with self.subTest(body=body):
                self.assert_source(self.deny_list() + body, SCRIPT)
        self.assert_source('const n = "state.sqlite"; join(homedir(), ".robob", "userdata", n);', SCRIPT)

    def test_config_basename_reuse_keeps_live_root_evidence(self):
        for value in ('join(homedir(), ".config", "mytool", "state.sqlite")',
                      '"~/.config/mytool/state.sqlite"'):
            with self.subTest(value=value):
                self.assert_source(f'const p = {value};\n'
                                   'open(join(homedir(), ".robob", "userdata", path.basename(p)));', SCRIPT)

    def test_config_name_reuse_in_protected_cwd(self):
        roots = (self.root / '.robob/userdata', self.root / '.robob/userdata/archive',
                 self.root / 'robob-data/userdata', self.root / '.local/share/opencode',
                 self.root / 'opencode-data', Path.home() / '.t3/userdata')
        for root in roots:
            if root.is_relative_to(self.root):
                root.mkdir(parents=True, exist_ok=True)
        alias = self.root / 'alias'
        alias.symlink_to(roots[0], target_is_directory=True)
        roots += (alias,)
        imports = ('import path from "node:path";\n'
                   'const { DatabaseSync } = await import("node:sqlite");\n')
        for operand in ('"~/.config/mytool/state.sqlite"',
                        'join(homedir(), ".config", "mytool", "state.sqlite")',
                        '["state.sqlite"].map(n => join(homedir(), ".config", "mytool", n))[0]'):
            source = imports + f'const p = {operand};\nnew DatabaseSync(path.basename(p));\n'
            script = self.root / 'reuse.mjs'
            script.write_text(source)
            for cwd in roots:
                with self.subTest(operand=operand, cwd=cwd):
                    assert_verdict(self, 'node ' + shlex.quote(str(script)), cwd, SCRIPT)
                    stdin = "node - <<'JS'\n" + source + 'JS'
                    assert_verdict(self, stdin, cwd, READ)
                    assert_verdict(self, 'bash -c ' + shlex.quote(stdin), cwd, READ)
            with self.subTest(operand=operand, cwd='isolated'):
                assert_verdict(self, 'node ' + shlex.quote(str(script)), self.root, SCRIPT)


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

    def test_policy_runs_before_identity_or_offbox_and_does_not_log_sql(self):
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


class ZshStartupTests(unittest.TestCase):
    REPORTERS = (
        '/Users/ardud/.robob/worktrees/t3code-fork/installer-backups/integrations/run-cloud/install.zsh',
        '/Users/ardud/.robob/worktrees/t3code-fork/fix-offbox-pinned-hold-254/integrations/offbox/install.zsh',
        '/Users/ardud/.robob/release-builds/release-20261113.13-s13/build/build.zsh',
        '/Volumes/ExternalSSD/t3code-wt/mac-read-watchdog-bounded-probe/integrations/local-helpers/bin/robob-read-watchdog',
        '/Volumes/ExternalSSD/t3code-fork/integrations/local-helpers/bin/opencode-web',
        '/Users/ardud/.robob/install-20261113.14-sup/run-install.zsh',
    )

    def setUp(self):
        clean = isolated_source_cases.fixture_environment_patch()
        clean.start()
        self.addCleanup(clean.stop)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.global_env = self.root / 'zshenv'
        global_path = patch.object(guard, 'ZSH_GLOBAL_ENV', str(self.global_env))
        global_path.start()
        self.addCleanup(global_path.stop)
        # Classification must not depend on zsh being installed on the box.
        which = guard.shutil.which
        lookup = patch.object(guard.shutil, 'which', side_effect=lambda name, *a, **kw:
                              '/bin/zsh' if name == 'zsh' else which(name, *a, **kw))
        lookup.start()
        self.addCleanup(lookup.stop)
        self.script = self.root / 'check.zsh'
        self.script.write_text('echo ok\n')

    def test_zsh_no_rcs_parse_only_forms(self):
        rows = [
            '/bin/zsh -f -n ' + str(self.script),
            'zsh -fn check.zsh', 'zsh -nf check.zsh', 'zsh -efn check.zsh', 'zsh -n -f check.zsh',
            '/bin/zsh --no-rcs -n ' + str(self.script),
            'zsh --norcs -n check.zsh', 'zsh -o norcs -n check.zsh',
            'zsh +o rcs -n check.zsh', 'zsh -f -n -- check.zsh',
            *(f'zsh {flags} check.zsh' for flags in
              ('-dfn', '-dnf', '-fdn', '-fnd', '-ndf', '-nfd', '-d -fn', '-f -d -n', '-fn -d')),
            '/bin/zsh -dfn /Users/ardud/.robob/install-20261113.14-sup/run-install.zsh',
            *('/bin/zsh -f -n ' + target for target in self.REPORTERS),
        ]
        lstat = os.lstat
        root_file = os.stat_result((stat.S_IFREG | 0o644, 1, 1, 1, 0, 0, 0, 0, 0, 0))
        for present in (False, True):
            with self.subTest(global_env_present=present):
                def global_stat(path, *args, **kwargs):
                    return root_file if present and os.fspath(path) == str(self.global_env) else lstat(path, *args, **kwargs)
                with patch.object(os, 'lstat', side_effect=global_stat):
                    for command in rows:
                        with self.subTest(command=command):
                            self.assertEqual(guard.classify_detail(command, str(self.root)), (None, None))

    def test_zsh_startup_options_remain_bounded(self):
        rows = ('-n', '-n check.zsh', '-l -f -n', '--login -f -n', '-i -f -n',
                '-f -o rcs -n', '-f +o norcs -n', '-f +f -n', '-f --unknown -n',
                '-o rcs -f -n', '-f -o unknown -n', '-fln', '-fin', '-n check.zsh -f',
                '-dn', '-d -n', '-gfn', '-hfn', '-dgfn', '-fD -n', '-d -f -o rcs -n')
        for options in rows:
            with self.subTest(options=options):
                rule, cause = guard.classify_detail('zsh ' + options + ' check.zsh', str(self.root))
                self.assertEqual(rule, UNRESOLVED, cause)
                self.assertIn('zsh: implicit startup unproved', cause)
                message = guard.refusal_reason(rule, cause, str(self.root))
                self.assertIn('zsh -f -n', message)
                self.assertIn('one file per call', message)
                self.assertNotIn('literal absolute script path', message)

        command = '/bin/zsh -n /Volumes/ExternalSSD/t3code-fork/integrations/local-helpers/bin/opencode-web'
        rule, cause = guard.classify_detail(command, str(self.root))
        self.assertEqual(rule, UNRESOLVED, cause)
        self.assertIn('zsh: implicit startup unproved', cause)

    def test_zsh_global_startup_file_trust(self):
        for mode, uid in ((stat.S_IFREG | 0o664, 0), (stat.S_IFREG | 0o646, 0),
                          (stat.S_IFREG | 0o644, 501), (stat.S_IFLNK | 0o777, 0),
                          (stat.S_IFDIR | 0o755, 0), (stat.S_IFIFO | 0o600, 0)):
            info = os.stat_result((mode, 1, 1, 1, uid, 0, 0, 0, 0, 0))
            lstat = os.lstat
            with self.subTest(mode=mode, uid=uid), patch.object(os, 'lstat', side_effect=lambda path, *a, **kw:
                    info if os.fspath(path) == str(self.global_env) else lstat(path, *a, **kw)):
                rule, cause = guard.classify_detail('zsh -f -n check.zsh', str(self.root))
                self.assertEqual(rule, UNRESOLVED, cause)
                self.assertIn('zsh: /etc/zshenv startup unproved', cause)
                message = guard.refusal_reason(rule, cause, str(self.root))
                self.assertNotIn('literal absolute script path', message)
                self.assertNotIn('Use zsh -f -n', message)
        for error in (PermissionError('unreadable'), OSError('unavailable')):
            lstat = os.lstat
            def global_error(path, *args, **kwargs):
                if os.fspath(path) == str(self.global_env):
                    raise error
                return lstat(path, *args, **kwargs)
            with self.subTest(error=type(error).__name__), patch.object(os, 'lstat', side_effect=global_error):
                self.assertEqual(guard.classify('zsh -f -n check.zsh', str(self.root)), UNRESOLVED)

    def test_zsh_preserves_environment_and_mutation_checks(self):
        for prefix in ('ZDOTDIR=/tmp/x ', 'ENV=/tmp/x ', 'BASH_ENV=/tmp/x ', 'DYLD_INSERT_LIBRARIES=/tmp/x '):
            with self.subTest(prefix=prefix):
                rule, cause = guard.classify_detail(prefix + 'zsh -f -n check.zsh', str(self.root))
                self.assertEqual(rule, UNRESOLVED)
                self.assertNotIn('literal absolute script path', guard.refusal_reason(rule, cause, str(self.root)))
        with patch.dict(os.environ, {'ZDOTDIR': '/tmp/x'}):
            self.assertEqual(guard.classify('zsh -f -n check.zsh', str(self.root)), UNRESOLVED)
        for prefix in ('cp replacement ' + str(self.global_env), 'echo changed > ' + str(self.global_env),
                       'cp replacement /bin/zsh'):
            with self.subTest(prefix=prefix):
                self.assertEqual(guard.classify(prefix + '\nzsh -f -n check.zsh', str(self.root)), UNRESOLVED)
        self.assertEqual(guard.classify('zsh -f -n ' + LIVE, str(self.root)), READ)
        (self.root / 'database-alias').symlink_to(LIVE)
        self.assertEqual(guard.classify('zsh -f -n database-alias', str(self.root)), READ)
        self.script.write_text('cat ' + LIVE + '\n')
        self.assertEqual(guard.classify('zsh -f check.zsh', str(self.root)), SCRIPT)
        self.assertEqual(guard.classify('zsh -f -c ' + shlex.quote('cat ' + LIVE), str(self.root)), READ)

    def test_zsh_execution_option_forms_scan_source(self):
        source = 'cat ' + LIVE + '\n'
        self.script.write_text(source)
        options = ('-f -e', '-e -f', '-fe', '-ef', '-e -o norcs', '-o norcs -e',
                   '-e +o rcs', '+o rcs -e', '--no-rcs -e', '-e --no-rcs',
                   '-f -u', '-fu', '-uf', '-f -v', '-fv', '-vf', '-f -x', '-fx', '-xf')
        writer = "cat > check.zsh <<'SOURCE'\n" + source + 'SOURCE\n'
        for flags in options:
            for prefix in ('', writer):
                with self.subTest(flags=flags, same_call=bool(prefix)):
                    command = prefix + '/bin/zsh ' + flags + ' check.zsh'
                    self.assertEqual(guard.classify(command, str(self.root)), SCRIPT)
            with self.subTest(flags=flags, mode='inline'):
                command = '/bin/zsh ' + flags + ' -c ' + shlex.quote(source)
                self.assertEqual(guard.classify(command, str(self.root)), READ)
            with self.subTest(flags=flags, mode='stdin'):
                command = '/bin/zsh ' + flags + " -s <<'SOURCE'\n" + source + 'SOURCE\n'
                self.assertEqual(guard.classify(command, str(self.root)), READ)
        self.script.write_text('echo ok\n')
        for flags in options:
            with self.subTest(flags=flags, mode='safe script'):
                self.assertEqual(guard.classify('/bin/zsh ' + flags + ' check.zsh', str(self.root)), None)

    def test_zsh_no_global_rcs_keeps_startup_and_execution_checks(self):
        source = 'cat ' + LIVE + '\n'
        self.script.write_text(source)
        writer = "cat > check.zsh <<'SOURCE'\n" + source + 'SOURCE\n'
        for flags in ('-df', '-fd', '-d -f', '-f -d'):
            for prefix in ('', writer):
                with self.subTest(flags=flags, same_call=bool(prefix)):
                    self.assertEqual(guard.classify(prefix + '/bin/zsh ' + flags + ' check.zsh', str(self.root)), SCRIPT)
            with self.subTest(flags=flags, inline=True):
                self.assertEqual(guard.classify('/bin/zsh ' + flags + ' -c ' + shlex.quote(source), str(self.root)), READ)
        info = os.stat_result((stat.S_IFREG | 0o666, 1, 1, 1, 0, 0, 0, 0, 0, 0))
        lstat = os.lstat
        with patch.object(os, 'lstat', side_effect=lambda path, *a, **kw:
                          info if os.fspath(path) == str(self.global_env) else lstat(path, *a, **kw)):
            rule, cause = guard.classify_detail('/bin/zsh -dfn check.zsh', str(self.root))
            self.assertEqual(rule, UNRESOLVED, cause)
            self.assertIn('zsh: /etc/zshenv startup unproved', cause)
        self.assertEqual(guard.classify('ZDOTDIR=/tmp/x /bin/zsh -dfn check.zsh', str(self.root)), UNRESOLVED)
        self.assertEqual(guard.classify('/bin/zsh -dfn ' + LIVE, str(self.root)), READ)

    def test_zsh_option_terminators_preserve_script_and_stdin_checks(self):
        options = ('-f -', '-f -e -', '-ef -', '-f -n -', '-fn -',
                   '-f -- -', '-f -e -- -', '-f -n -- -')
        for source in ('echo ok\n', 'cat ' + LIVE + '\n'):
            self.script.write_text(source)
            writer = "cat > check.zsh <<'SOURCE'\n" + source + 'SOURCE\n'
            for flags in options:
                for prefix in ('', writer):
                    with self.subTest(flags=flags, source=source, same_call=bool(prefix)):
                        rule, cause = guard.classify_detail(prefix + '/bin/zsh ' + flags + ' check.zsh', str(self.root))
                        self.assertEqual(rule, UNRESOLVED, cause)
                        self.assertIn('bare dash input unproved', cause)
        for target in ('check.zsh', '-e', '-n'):
            (self.root / target).write_text('cat ' + LIVE + '\n')
            with self.subTest(target=target):
                self.assertEqual(guard.classify('/bin/zsh -f -- ' + target, str(self.root)), SCRIPT)
        for flags in ('-f', '-f -', '-f --', '-f -- -'):
            for source, rule in (('echo ok\n', None), ('cat ' + LIVE + '\n', READ)):
                with self.subTest(flags=flags, stdin=source):
                    command = '/bin/zsh ' + flags + " <<'SOURCE'\n" + source + 'SOURCE\n'
                    self.assertEqual(guard.classify(command, str(self.root)), rule)

    def test_zsh_post_c_options_cannot_hide_command_or_change_execution(self):
        options = ('-f -c', '-fc', '-cf', '-fnc', '-fcn', '-nfc', '-f -nc', '-dfc', '-dcf', '-dfnc', '-d -f -c',
                   '--no-rcs -c', '-o norcs -c', '+o rcs -c')
        trailing = ('+n', '-e', '-u', '-v', '-x', '-n', '-f', '+f',
                    '-o rcs', '+o norcs', '-o norcs', '+o rcs',
                    '--rcs', '--no-rcs', '-l', '-i', '--unknown', '--', '-', '+')
        for source in ('echo ok\n', 'cat ' + LIVE + '\n'):
            self.script.write_text(source)
            writer = "cat > check.zsh <<'SOURCE'\n" + source + 'SOURCE\n'
            for flags in options:
                for after_c in trailing:
                    for prefix in ('', writer):
                        with self.subTest(flags=flags, after_c=after_c, source=source, same_call=bool(prefix)):
                            command = prefix + '/bin/zsh ' + flags + ' ' + after_c + " 'source check.zsh'"
                            rule, cause = guard.classify_detail(command, str(self.root))
                            self.assertEqual(rule, UNRESOLVED, cause)
                            self.assertIn('zsh: options after -c unproved', cause)
        for flags in options:
            with self.subTest(flags=flags, missing_command=True):
                rule, cause = guard.classify_detail('/bin/zsh ' + flags, str(self.root))
                self.assertEqual(rule, UNRESOLVED, cause)
                self.assertIn('zsh: options after -c unproved', cause)

    def test_zsh_literal_c_commands_keep_source_and_argument_boundaries(self):
        for flags in ('-f -c', '-fc', '-cf', '--no-rcs -c', '-o norcs -c', '+o rcs -c'):
            for source, expected in (('echo ok\n', None), ('cat ' + LIVE + '\n', SCRIPT)):
                self.script.write_text(source)
                writer = "cat > check.zsh <<'SOURCE'\n" + source + 'SOURCE\n'
                for prefix in ('', writer):
                    for arguments in ('', ' +n', ' -e', ' -o rcs'):
                        with self.subTest(flags=flags, source=source, same_call=bool(prefix), arguments=arguments):
                            command = prefix + '/bin/zsh ' + flags + " 'source check.zsh'" + arguments
                            self.assertEqual(guard.classify(command, str(self.root)), expected)
            with self.subTest(flags=flags, inline_read=True):
                command = '/bin/zsh ' + flags + ' ' + shlex.quote('cat ' + LIVE)
                self.assertEqual(guard.classify(command, str(self.root)), READ)
            with self.subTest(flags=flags, empty_command=True):
                self.assertEqual(guard.classify('/bin/zsh ' + flags + " ''", str(self.root)), None)


if __name__ == "__main__":
    unittest.main()

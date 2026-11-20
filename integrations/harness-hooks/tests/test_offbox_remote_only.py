"""#221: offbox payloads that can never run on the Mac skip local script proofs."""
if __package__:
    from . import test_environment
else:
    import test_environment

from pathlib import Path
import shlex
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import isolated_source_cases
import statev2_guard as guard


FIXTURES = Path(__file__).with_name('fixtures') / 'offbox-remote-only'
UNRESOLVED = 'live-database-script-unresolved'
SCRIPT = 'live-database-script'
READ = 'live-database-read'
LIVE_TEST = '''import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { test } from "bun:test";

test("opens the live db", () => {
  new Database(join(homedir(), ".local/share/opencode/opencode.db"));
});
'''
INSTALLER = ('task_tmp=$(mktemp -d); curl -LsSf https://astral.sh/uv/install.sh -o "$task_tmp/uv-install.sh"; '
             'sh "$task_tmp/uv-install.sh"')
# Crpko #4671 (rebuilt): a mktemp scratch copy, a JSON edit, then unittest
# discovery inside the copy.
SCRATCH_COPY = ('d=$(mktemp -d); cp -R terraform/modules/better-stack-alert-evaluator "$d/evaluator"; '
                'python3 -I -c "import json; print(json.dumps({}))"; '
                'python3 -m unittest discover -s "$d/evaluator/tests" -p test_x.py')


def fixture(name):
    return (FIXTURES / name).read_text()


class OffboxRemoteOnlyTests(unittest.TestCase):
    def setUp(self):
        clean = isolated_source_cases.fixture_environment_patch()
        clean.start()
        self.addCleanup(clean.stop)
        temp = tempfile.TemporaryDirectory(prefix='offbox-remote-only-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        for name in ('scripts/test-ci-role-a.mjs', 'scripts/test-ci-role-b.mjs',
                     'scripts/test-support-receipt-ledger.mjs', 'scripts/validate-plan-package.mjs',
                     'scripts/test-edge-runtime-access-decisions.mjs',
                     'integrations/router-logging/test/a.test.mjs', 'integrations/router-logging/test/b.test.mjs',
                     'packages/perf-harness/src/a.test.ts'):
            self.write(name, "import test from 'node:test'; test('x', () => {});\n")
        for name in ('scripts/test-ci-role-writer-guard.py', 'integrations/router-logging/test/test_proxy_rollup.py',
                     'terraform/modules/better-stack-alert-evaluator/tests/test_x.py'):
            self.write(name, 'print(1)\n')
        # A test file that opens the live database outright: only the box may run it.
        for name in ('test/robob.test.ts', 'test/router.test.ts', 'test/inbound-latency.test.ts',
                     'test/router-sendblue.test.ts'):
            self.write(name, LIVE_TEST)
        self.write('unproven.sh', 'sqlite3 ~/.t3/userdata/statev2.sqlite .tables\n')

    def write(self, name, source):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source)
        return path

    def decide(self, command):
        return guard.classify_detail(command, str(self.root))

    def assert_allowed(self, command):
        rule, cause = self.decide(command)
        self.assertIsNone(rule, (command, cause))

    def test_helper_mirrors_offbox_fallback_rule(self):
        def remote_only(command):
            words = shlex.split(command)
            text, quoted = guard._quoted_punctuation(command, script_literals=True)
            raw = shlex.split(text)
            return guard._offbox_remote_only(words, raw, quoted)

        for command, expected in [
            ('offbox run --bg -- ls', True),
            ('offbox run --no-fallback -- ls', True),
            ('offbox run --remote -- ls', True),
            ('offbox run --size small --bg -- ls', True),
            ('offbox run --include x --pull y --git -- ls', False),
            ('offbox run -- ls', False),
            ('offbox run -- sh ./x.sh', False),
            ("offbox run -- 'ls; ls'", True),
            ("offbox run -- 'a && b'", True),
            ("offbox run -- 'echo $HOME'", True),
            ("offbox run -- 'cat < x'", True),
            ("offbox run -- \"a; b\"", True),
            ('offbox run --step ls', False),
            ("offbox run --step 'ls; ls'", True),
            ('offbox run --step ls --step pwd', True),
            # Caller expansions may vanish before offbox reads its argv.
            ('offbox run -- sh $X', False),
            ('offbox run -- sh "$X"', False),
            # argparse puts flags after the first positional into the command.
            ('offbox run ls --bg', False),
            ('offbox run --unknown --bg -- ls', False),
            ('offbox run --bg=1 -- ls', False),
        ]:
            with self.subTest(command=command):
                self.assertIs(remote_only(command), expected)

    def test_mac104_installer_payload(self):
        command = fixture('mac104-exact.sh')
        self.assertIn('offbox run --bg -- ', command)
        for variant in (command, command.replace('--bg', '--no-fallback', 1), command.replace('--bg', '--remote', 1)):
            with self.subTest(variant=variant[:40]):
                self.assert_allowed(variant)
        self.assert_allowed("offbox run -- 'set -eu; d=$(mktemp -d); curl -fsSL https://example.invalid/i.sh "
                            "-o \"$d/i.sh\"; sh \"$d/i.sh\"'")

    def test_local_twins_are_still_checked(self):
        for command in (INSTALLER, shlex.split(fixture('mac104-exact.sh'))[-1], SCRATCH_COPY):
            with self.subTest(command=command[:60]):
                self.assertEqual(self.decide(command)[0], UNRESOLVED)
        # Payloads offbox may run locally after an outage keep every proof.
        for command in ('offbox run -- sh ./unproven.sh', "offbox run -- 'sh ./unproven.sh'",
                        "offbox run --step 'sh ./unproven.sh'", 'X=./unproven.sh; offbox run -- sh "$X"',
                        'offbox run -- bun test test/robob.test.ts', 'bun test test/robob.test.ts'):
            with self.subTest(command=command):
                self.assertEqual(self.decide(command)[0], SCRIPT)

    def test_live_database_literals_and_caller_side_paths_stay_denied(self):
        for command in [
            "offbox run --bg -- 'sqlite3 ~/.t3/userdata/statev2.sqlite .tables'",
            "offbox run --bg -- 'cd ~/.robob/userdata && sqlite3 statev2.sqlite .tables'",
            "offbox run --bg --step 'cp ~/.local/share/opencode/opencode.db x.db'",
            "offbox run --bg -- python3 - <<'PY'\nopen('/tmp/x/.robob/userdata/statev2.sqlite', 'rb')\nPY\n",
            'offbox run --bg -- cat < ~/.robob/userdata/statev2.sqlite',
            'DB=~/.t3/userdata/statev2.sqlite; offbox run --bg -- sqlite3 "$DB" .tables',
            "offbox run --bg --include ~/.local/share/opencode/opencode.db -- 'ls'",
            "offbox run --include=$HOME/.robob/userdata/statev2.sqlite-wal -- ls",
            "offbox run --bg --pull ~/.robob/userdata -- 'ls'",
            "offbox run --pull ~/.t3/userdata/statev2.sqlite -- ls",
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.decide(command)[0], READ)
        # The read-only replica stays public, and workspace .t3 copies are not live.
        self.assert_allowed("offbox run --bg -- 'ls ~/.robob/userdata/readonly/state.sqlite'")
        self.assert_allowed("offbox run --bg --include .t3/userdata/statev2.sqlite -- 'ls'")

    def test_files_a_remote_only_payload_executes_are_not_scanned(self):
        # iMessage #84 / #83: the box has no live database for these to open.
        for command in (
            "offbox run --bg -- 'bun install --frozen-lockfile && bun test test/robob.test.ts test/router.test.ts "
            "test/inbound-latency.test.ts test/router-sendblue.test.ts && bun run check'",
            "offbox run --no-fallback -- 'bun test test/robob.test.ts'",
            "offbox run --bg -- bun test test/robob.test.ts",
            "offbox run --bg -- 'sh ./unproven.sh'",
        ):
            with self.subTest(command=command):
                self.assert_allowed(command)

    def test_step_globs_scratch_copies_and_pwd_paths(self):
        for command in [
            # Crpko #3232 and 9router #65: nothing writes these globs.
            "offbox run --bg --step 'node scripts/validate-plan-package.mjs' --step 'node --test "
            "scripts/test-ci-role-*.mjs scripts/test-support-receipt-ledger.mjs' --step 'python3 -I "
            "scripts/test-ci-role-writer-guard.py'",
            "offbox run --bg --step 'python3 -I integrations/router-logging/test/test_proxy_rollup.py' --step "
            "'python3 -I -m unittest discover -s integrations/router-logging/test -p \"test_*.py\"' --step "
            "'node --test integrations/router-logging/test/*.test.mjs'",
            # Crpko #4671.
            'offbox run --bg --no-fallback --step ' + shlex.quote(SCRATCH_COPY),
            # Crpko #4207.
            "offbox run --bg --step 'node --version' --step 'node --test "
            "\"$PWD/scripts/test-edge-runtime-access-decisions.mjs\"'",
        ]:
            with self.subTest(command=command[:70]):
                self.assert_allowed(command)

    def test_reporter_exact_commands(self):
        # Robob #1824, Crpko #2343, #196's Crpko #4500 and iMessage #53.
        for name in ('robob1824-exact.sh', 'crpko2343-exact.sh', 'crpko4500-exact.sh', 'imessage53-exact.sh'):
            with self.subTest(name=name):
                self.assert_allowed(fixture(name))

    def test_heredoc_then_local_run_is_still_checked(self):
        heredoc, _, remote = fixture('crpko2343-exact.sh').partition('\noffbox run ')
        self.assertTrue(remote)
        probe = 'tmp/pr444-r2.rgLbUX/probe.py'
        self.assertIsNotNone(self.decide(heredoc + '\nuv run python -I ' + probe)[0])
        live = "cat > tmp/x/probe.py <<'PY'\nopen('/tmp/y/.robob/userdata/statev2.sqlite', 'rb')\nPY\n"
        self.assertIsNotNone(self.decide(live + 'python3 -I tmp/x/probe.py')[0])
        self.assert_allowed(live + "offbox run --bg --include tmp/x -- 'uv run python -I tmp/x/probe.py'")
        report, _, _ = fixture('imessage53-exact.sh').partition('\noffbox run ')
        self.assertEqual(self.decide(report + '\nbun test test/robob.test.ts')[0], SCRIPT)

    def test_refusal_names_the_download_not_the_lookup(self):
        command = ('task_tmp=$(mktemp -d)\n'
                   'if ! command -v uv >/dev/null; then\n'
                   '  curl -LsSf https://astral.sh/uv/install.sh -o "$task_tmp/uv-install.sh"\n'
                   '  sh "$task_tmp/uv-install.sh"\n'
                   'fi\n'
                   'uv python install 3.9\n')
        rule, cause = self.decide(command)
        self.assertEqual(rule, UNRESOLVED)
        self.assertIn('invalidated by curl command at line 3', cause)
        rule, cause = self.decide(shlex.split(fixture('mac104-exact.sh'))[-1])
        self.assertIn('invalidated by curl command at line 1', cause)
        self.assertNotIn('uv command', cause)

    def test_lookup_builtin_keeps_a_fresh_scratch_proof(self):
        body = "d=$(mktemp -d); cat > \"$d/x.sh\" <<'EOF'\necho ok\nEOF\n"
        for lookup in ('command -v uv >/dev/null\n', 'if ! command -V uv >/dev/null 2>&1; then echo no; fi\n'):
            with self.subTest(lookup=lookup):
                self.assertIsNone(self.decide(body + 'sh "$d/x.sh"')[0])
                self.assertIsNone(self.decide(body + lookup + 'sh "$d/x.sh"')[0])
        # Running the name, or a /dev/null redirect beside a real write, still voids it.
        self.assertIsNotNone(self.decide(body + 'command uv sync\nsh "$d/x.sh"')[0])
        self.assertIsNotNone(self.decide(body + 'cp /dev/null "$d/x.sh"\nsh "$d/x.sh"')[0])


if __name__ == '__main__':
    unittest.main()

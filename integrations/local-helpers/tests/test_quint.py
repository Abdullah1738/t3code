"""Exercise the wrapper with fake toolchains; never starts Apalache or touches ~/.quint."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest


HERE = Path(__file__).resolve().parents[1]


class QuintTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="quint-wrapper-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.brew = self.root / "brew-jdk"
        self.probe = self.root / "java_home"
        self.wrapper = self.root / "wrapper" / "quint"
        # Substitute only the two absolute OS probes, so tests never use the Mac's JDK.
        source = (HERE / "bin/quint").read_text().replace(
            "/opt/homebrew/opt/openjdk", str(self.brew)
        ).replace("/usr/libexec/java_home", str(self.probe))
        self.script(self.wrapper, source)
        self.script(self.probe, "#!/bin/sh\nexit 1\n")
        self.jdk(self.brew)
        self.cli = self.root / "cli" / "quint"
        self.fake_quint(self.cli)
        self.env = {
            "HOME": str(self.root),
            "PATH": f"{self.wrapper.parent}:{self.cli.parent}:/usr/bin:/bin",
        }

    def script(self, file, text):
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)
        file.chmod(0o755)

    def jdk(self, home, version='openjdk version "21.0.13"', exit_code=0):
        self.script(home / "bin/java", f"#!/bin/sh\ncat <<'VERSION' >&2\n{version}\nVERSION\nexit {exit_code}\n")

    def fake_quint(self, path):
        self.script(path, """#!/usr/bin/python3
import json, os, sys
print(json.dumps({'argv': sys.argv[1:], 'java_home': os.environ['JAVA_HOME'],
                  'path': os.environ['PATH'], 'cli': sys.argv[0], 'pid': os.getpid()}))
sys.exit(int(os.environ.get('FAKE_EXIT', '0')))
""")

    def run_cli(self, *args, **env):
        return subprocess.run([str(self.wrapper), *args], env={**self.env, **env},
                              text=True, capture_output=True, timeout=10)

    def result(self, *args, **env):
        r = self.run_cli(*args, **env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_override_wins_over_brew_and_ambient_java_home(self):
        custom = self.root / "custom jdk"
        self.jdk(custom, 'java version "25.0.1"')
        data = self.result("--version", QUINT_JAVA_HOME=str(custom), JAVA_HOME="/wrong")
        self.assertEqual(data["java_home"], str(custom))
        self.assertEqual(data["path"].split(":")[0], str(custom / "bin"))

    def test_version_formats(self):
        for version in ('openjdk version "21"', 'openjdk version "21.0.13"',
                        'java version "27.0.1.0.3"', 'openjdk version "21-ea"',
                        'openjdk version "21+35"'):
            with self.subTest(version=version):
                self.jdk(self.brew, version)
                self.result("--version")

    def test_bad_explicit_jdk_never_falls_back_to_brew(self):
        custom = self.root / "bad-jdk"
        for version in ('openjdk version "11.0.31"', 'java version "1.8.0_442"',
                        'openjdk version "20.0.2"', 'unparseable'):
            with self.subTest(version=version):
                self.jdk(custom, version)
                r = self.run_cli("verify", "a.qnt", QUINT_JAVA_HOME=str(custom))
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("Java 21+", r.stderr)
                self.assertIn("brew install openjdk", r.stderr)
                self.assertEqual(r.stdout, "")
        for home in ("", str(self.root / "missing")):
            with self.subTest(home=home):
                self.assertNotEqual(self.run_cli("--version", QUINT_JAVA_HOME=home).returncode, 0)

    def test_brew_selected_by_default(self):
        self.assertEqual(self.result("--version")["java_home"], str(self.brew))

    def test_old_missing_or_broken_brew_uses_java_home(self):
        other = self.root / "system jdk"
        self.jdk(other)
        self.script(self.probe, f'#!/bin/sh\n[ "$1" = -v ] && [ "$2" = "21+" ] || exit 1\nprintf "%s\\n" "{other}"\n')
        for version, code in (('openjdk version "11.0.31"', 0),
                              ('openjdk version "21.0.13"', 1)):
            with self.subTest(version=version, code=code):
                self.jdk(self.brew, version, code)
                self.assertEqual(self.result("--version")["java_home"], str(other))
        (self.brew / "bin/java").unlink()
        self.assertEqual(self.result("--version")["java_home"], str(other))

    def test_no_compatible_jdk_refused(self):
        self.jdk(self.brew, 'openjdk version "11.0.31"')
        r = self.run_cli("--version")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("brew install openjdk", r.stderr)

    def test_java_home_result_is_also_version_checked(self):
        self.jdk(self.brew, 'openjdk version "11.0.31"')
        self.script(self.probe, f'#!/bin/sh\necho "{self.brew}"\n')
        self.assertNotEqual(self.run_cli("--version").returncode, 0)

    def test_verify_gets_free_port_and_preserves_arguments(self):
        args = ("verify", "model with spaces.qnt", "--invariant", "ok", "--max-steps", "5")
        data = self.result(*args)
        forwarded = data["argv"]
        self.assertEqual(forwarded[1], "--server-endpoint")
        host, port = forwarded[2].split(":")
        self.assertEqual(host, "localhost")
        self.assertGreater(int(port), 0)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", int(port)))
        self.assertEqual([forwarded[0], *forwarded[3:]], list(args))

    def test_explicit_endpoint_forms_unchanged(self):
        for endpoint in (("--server-endpoint", "localhost:9123"),
                         ("--server-endpoint=localhost:9123",),
                         ("--serverEndpoint", "localhost:9123"),
                         ("--serverEndpoint=localhost:9123",),
                         ("--no-server-endpoint",),
                         ("--no-serverEndpoint",),
                         ("--server-endpoint=",)):
            with self.subTest(endpoint=endpoint):
                args = ["verify", "a.qnt", *endpoint]
                self.assertEqual(self.result(*args)["argv"], args)

    def test_leading_option_forms(self):
        for prefix in (["--verbosity=0"], ["--verbosity", "0"],
                       ["--main=Counter", "--maxSteps", "5"],
                       ["--out", "--verbosity", "0"], ["--out", ""],
                       ["--out", "-"], ["--max-steps", "-1"], ["--maxSteps", "-0.5"],
                       ["--out", "verify"], ["--random-transitions"],
                       ["--randomTransitions", "false"], ["--random-transitions=false"],
                       ["--no-random-transitions"], ["--no-randomTransitions"],
                       ["--help"], ["--version", "false"], ["--no-help"], ["--no-version"]):
            with self.subTest(prefix=prefix):
                args = [*prefix, "verify", "a.qnt"]
                forwarded = self.result(*args)["argv"]
                insert = len(prefix) + 1
                self.assertEqual(forwarded[insert], "--server-endpoint")
                self.assertTrue(forwarded[insert + 1].startswith("localhost:"))
                self.assertEqual(forwarded[:insert] + forwarded[insert + 2:], args)

    def test_negated_scalar_options_do_not_consume_the_command(self):
        # Yargs accepts negation on number/string options too, not only booleans.
        for prefix in ("--no-verbosity", "--no-max-steps", "--no-maxSteps",
                       "--no-main", "--no-init", "--no-inductive-invariant",
                       "--no-inductiveInvariant", "--no-out", "--no-out-itf",
                       "--no-outItf", "--no-backend", "--no-apalache-version",
                       "--no-apalacheVersion", "--no-tlc-config", "--no-tlcConfig"):
            with self.subTest(prefix=prefix):
                forwarded = self.result(prefix, "verify", "a.qnt")["argv"]
                self.assertEqual(forwarded[:3], [prefix, "verify", "--server-endpoint"])
                self.assertTrue(forwarded[3].startswith("localhost:"))
                self.assertEqual(forwarded[4:], ["a.qnt"])

    def test_leading_explicit_endpoint_aliases_unchanged(self):
        for endpoint in (["--server-endpoint", "localhost:9123"],
                         ["--server-endpoint=localhost:9123"],
                         ["--serverEndpoint", "localhost:9123"],
                         ["--serverEndpoint=localhost:9123"],
                         ["--no-server-endpoint"], ["--no-serverEndpoint"]):
            with self.subTest(endpoint=endpoint):
                args = [*endpoint, "verify", "a.qnt"]
                self.assertEqual(self.result(*args)["argv"], args)

    def test_leading_invariant_arrays_preserve_command_shaped_values(self):
        for prefix in (["--invariants", "inv1", "verify", "inv3", "--max-steps=1"],
                       ["--invariants=inv1", "verify", "inv3", "--max-steps=1"],
                       ["--invariants", "--max-steps", "1"],
                       ["--invariants=inv1", "inv2", "--verbosity", "0"],
                       ["--invariants", "-1", "verify", "--max-steps", "1"],
                       ["--invariants=--serverEndpoint", "verify", "--verbosity=0"],
                       ["--invariants", "inv1", "--invariants=inv2", "verify", "--verbosity=0"]):
            with self.subTest(prefix=prefix):
                args = [*prefix, "verify", "a.qnt"]
                forwarded = self.result(*args)["argv"]
                insert = len(prefix) + 1
                self.assertEqual(forwarded[insert], "--server-endpoint")
                self.assertTrue(forwarded[insert + 1].startswith("localhost:"))
                self.assertEqual(forwarded[:insert] + forwarded[insert + 2:], args)

    def test_invariant_array_consuming_all_positionals_is_not_a_command(self):
        for args in (["--invariants", "inv1", "verify", "a.qnt"],
                     ["--invariants=inv1", "verify", "a.qnt"]):
            with self.subTest(args=args):
                self.assertEqual(self.result(*args)["argv"], args)

    def test_verify_option_values_and_delimited_positionals_are_not_commands(self):
        for args in (["--out", "verify", "run", "a.qnt"],
                     ["--main=verify", "run", "a.qnt"], ["--", "verify", "a.qnt"],
                     ["--out", "--", "verify", "a.qnt"]):
            with self.subTest(args=args):
                self.assertEqual(self.result(*args)["argv"], args)

    def test_option_inserted_before_delimiter(self):
        args = self.result("verify", "--", "--server-endpoint")["argv"]
        self.assertEqual(args[1], "--server-endpoint")
        self.assertEqual(args[3:], ["--", "--server-endpoint"])

    def test_other_commands_unchanged(self):
        for args in ([], ["--version"], ["run", "a.qnt"], ["typecheck", "a.qnt"],
                     ["parse", "a.qnt"], ["run", "verify"]):
            with self.subTest(args=args):
                self.assertEqual(self.result(*args)["argv"], args)

    def test_quint_override_and_short_path(self):
        self.assertEqual(self.result("--version", QUINT_BIN=str(self.cli))["cli"], str(self.cli))
        self.assertEqual(self.result("--version", QUINT_BIN=str(self.cli), PATH="/usr/bin:/bin")["cli"], str(self.cli))

    def test_skips_self_and_symlink_on_path(self):
        alias = self.root / "alias/quint"
        alias.parent.mkdir()
        alias.symlink_to(self.wrapper)
        data = self.result("--version", PATH=f"{alias.parent}:{self.env['PATH']}")
        self.assertEqual(data["cli"], str(self.cli))

    def test_invalid_quint_override_refused(self):
        for value in (str(self.wrapper), str(self.root / "missing"), str(self.root), ""):
            with self.subTest(value=value):
                r = self.run_cli("--version", QUINT_BIN=value)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("npm i -g @informalsystems/quint@0.33.1", r.stderr)

    def test_nvm_fallback_supplies_adjacent_node_on_short_path(self):
        fallback = self.root / ".nvm/versions/node/v26.2.0/bin/quint"
        self.script(fallback, '#!/usr/bin/env node\n')
        self.script(fallback.parent / "node", '#!/bin/sh\nprintf "node:%s\\n" "$1"\n')
        r = self.run_cli("--version", PATH=f"{self.wrapper.parent}:/usr/bin:/bin")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), f"node:{fallback}")

    def test_missing_quint_has_install_hint(self):
        r = self.run_cli("--version", PATH=f"{self.wrapper.parent}:/usr/bin:/bin")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("npm i -g @informalsystems/quint@0.33.1", r.stderr)

    def test_exit_status_and_process_identity_preserved(self):
        r = self.run_cli("verify", "a.qnt", FAKE_EXIT="17")
        self.assertEqual(r.returncode, 17)
        child = subprocess.Popen([str(self.wrapper), "--version"], env=self.env,
                                 text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, err = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 0, err)
        self.assertEqual(json.loads(out)["pid"], child.pid)


if __name__ == "__main__":
    unittest.main()

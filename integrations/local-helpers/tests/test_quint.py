"""Exercise the wrapper with fake toolchains; never starts Apalache or touches ~/.quint."""
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import tarfile
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
        self.archive = self.root / 'patched.tgz'
        with tarfile.open(self.archive, 'w:gz') as bundle:
            for name, data, mode in (
                ('apalache/lib/apalache.jar', b'patched-jar', 0o644),
                ('apalache/bin/apalache-mc', b'#!/bin/sh\nexec "$JAVA_HOME/bin/java" "$@"\n', 0o755),
            ):
                entry = tarfile.TarInfo(name)
                entry.size, entry.mode = len(data), mode
                bundle.addfile(entry, io.BytesIO(data))
        source = source.replace('b4fc81998dd20d0b55a48c16d1caed1045e324bbbfe45ee7f625f6aaf70caf6f', hashlib.sha256(self.archive.read_bytes()).hexdigest())
        source = source.replace('cb6a7d689b2937b00be5e7e30e9bb1925cde7c8ce47aaafddb1cf21c8c167593', hashlib.sha256(b'patched-jar').hexdigest())
        self.script(self.wrapper, source)
        self.script(self.probe, "#!/bin/sh\nexit 1\n")
        self.jdk(self.brew)
        self.cli = self.root / "cli" / "quint"
        self.fake_quint(self.cli)
        self.env = {
            "HOME": str(self.root),
            "PATH": f"{self.wrapper.parent}:{self.cli.parent}:/usr/sbin:/usr/bin:/bin",
            "QUINT_APALACHE_ARCHIVE": str(self.archive),
            "FAKE_SERVER_LOG": str(self.root / 'server.json'),
        }

    def script(self, file, text):
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)
        file.chmod(0o755)

    def jdk(self, home, version='openjdk version "21.0.13"', exit_code=0):
        self.script(home / "bin/java", f'''#!/usr/bin/python3
import json, os, socket, sys, time
if sys.argv[1:] == ['-version']:
    print({version!r}, file=sys.stderr)
    sys.exit({exit_code})
port = int(sys.argv[2].split('=')[1])
sock = socket.socket()
sock.bind(('127.0.0.1', port))
sock.listen()
with open(os.environ['FAKE_SERVER_LOG'], 'w') as log:
    json.dump({{'pid': os.getpid(), 'argv': sys.argv[1:], 'jvm_args': os.environ.get('JVM_ARGS'), 'home': os.environ.get('QUINT_HOME'), 'jar': os.environ.get('APALACHE_JAR')}}, log)
if os.environ.get('FAKE_SERVER_EXIT'): sys.exit(9)
while True: time.sleep(1)
''')

    def fake_quint(self, path):
        self.script(path, """#!/usr/bin/python3
import json, os, sys, subprocess, time
print(json.dumps({'argv': sys.argv[1:], 'java_home': os.environ['JAVA_HOME'],
                  'path': os.environ['PATH'], 'cli': sys.argv[0], 'pid': os.getpid(),
                  'quint_home': os.environ.get('QUINT_HOME'), 'jvm_args': os.environ.get('JVM_ARGS')}), flush=True)
mode = os.environ.get('FAKE_MODE')
if mode == 'download':
    sys.stdout.write('Downloading '); sys.stdout.flush()
    time.sleep(.02)
    print('Apalache distribution 0.62.4...', flush=True)
if mode == 'launch':
    subprocess.run([os.environ['QUINT_HOME']+'/apalache-dist-0.62.4/apalache/bin/apalache-mc', 'server', '--port=8888'])
if mode == 'launch-message': print('Started Apalache server on pid=1234', file=sys.stderr)
if mode == 'wait': time.sleep(30)
sys.exit(int(os.environ.get('FAKE_EXIT', '0')))
""")

    def run_cli(self, *args, **env):
        return subprocess.run([str(self.wrapper), *args], env={**self.env, **env},
                              text=True, capture_output=True, timeout=10)

    def result(self, *args, **env):
        r = self.run_cli(*args, **env)
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(r.stdout)
        data['raw_argv'] = list(data['argv'])
        if '--apalache-version=0.62.4' in data['argv']:
            data['argv'].remove('--apalache-version=0.62.4')
        return data

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
                         ("--serverEndpoint=localhost:9123",)):
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
                       "--no-outItf", "--no-backend", "--no-tlc-config", "--no-tlcConfig"):
            with self.subTest(prefix=prefix):
                forwarded = self.result(prefix, "verify", "a.qnt")["argv"]
                self.assertEqual(forwarded[:3], [prefix, "verify", "--server-endpoint"])
                self.assertTrue(forwarded[3].startswith("localhost:"))
                self.assertEqual(forwarded[4:], ["a.qnt"])

    def test_leading_explicit_endpoint_aliases_unchanged(self):
        for endpoint in (["--server-endpoint", "localhost:9123"],
                         ["--server-endpoint=localhost:9123"],
                         ["--serverEndpoint", "localhost:9123"],
                         ["--serverEndpoint=localhost:9123"]):
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

    def server_stopped(self):
        data = json.loads((self.root / 'server.json').read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(data['pid'], 0)
        port = int(data['argv'][1].split('=')[1])
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', port))
        self.assertFalse(Path(data['home']).exists())
        return data

    def test_guard_launches_pinned_server_and_fences_ambient_home(self):
        data = self.result('verify', 'a.qnt', QUINT_HOME='/unsafe-ambient-cache', APALACHE_JAR='/unsafe-ambient.jar')
        server = self.server_stopped()
        self.assertEqual(server['argv'][0], 'server')
        self.assertRegex(server['argv'][1], r'^--port=[0-9]+$')
        self.assertIn('-Dcom.google.protobuf.error_on_unsafe_pre22_gencode=true', server['jvm_args'])
        self.assertEqual(server['home'], data['quint_home'])
        self.assertNotEqual(data['quint_home'], '/unsafe-ambient-cache')
        self.assertNotEqual(server['jar'], '/unsafe-ambient.jar')
        self.assertIn('--apalache-version=0.62.4', data['raw_argv'])

    def test_success_and_failure_stop_only_owned_server(self):
        with socket.socket() as unrelated:
            unrelated.bind(('127.0.0.1', 0)); unrelated.listen()
            for code in ('0', '17'):
                r = self.run_cli('verify', 'a.qnt', FAKE_EXIT=code)
                self.assertEqual(r.returncode, int(code), r.stderr)
                self.server_stopped()
                with socket.create_connection(unrelated.getsockname()): pass

    def test_quint_download_and_launch_are_failures_even_on_exit_zero(self):
        for mode in ('download', 'launch', 'launch-message'):
            with self.subTest(mode=mode):
                r = self.run_cli('verify', 'a.qnt', FAKE_MODE=mode)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn('Quint attempted', r.stderr)
                self.server_stopped()

    def test_missing_and_mismatched_archive_never_start_backend(self):
        for archive in (self.root / 'missing', self.root / 'wrong.tgz'):
            if archive.name.startswith('wrong'): archive.write_bytes(b'wrong')
            r = self.run_cli('verify', 'a.qnt', QUINT_APALACHE_ARCHIVE=str(archive))
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('archive', r.stderr)
            self.assertFalse((self.root / 'server.json').exists())

    def test_jar_pin_is_checked_separately(self):
        text = self.wrapper.read_text().replace(hashlib.sha256(b'patched-jar').hexdigest(), '0'*64)
        self.wrapper.write_text(text)
        r = self.run_cli('verify', 'a.qnt')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('jar sha256 mismatch', r.stderr)
        self.assertFalse((self.root / 'server.json').exists())

    def test_unsafe_opt_in_is_explicit_and_visible(self):
        for value in ('', 'true', '0'):
            r = self.run_cli('verify', 'a.qnt', QUINT_ALLOW_VULNERABLE_APALACHE=value, QUINT_APALACHE_ARCHIVE='/missing')
            self.assertNotEqual(r.returncode, 0)
        data = self.result('verify', 'a.qnt', QUINT_ALLOW_VULNERABLE_APALACHE='1', QUINT_APALACHE_ARCHIVE='/missing', QUINT_HOME='/user-cache')
        self.assertEqual(data['quint_home'], '/user-cache')
        self.assertNotIn('--apalache-version=0.62.4', data['raw_argv'])
        self.assertFalse((self.root / 'server.json').exists())
        r = self.run_cli('verify', 'a.qnt', QUINT_ALLOW_VULNERABLE_APALACHE='1')
        self.assertIn('bypassing the patched backend guard', r.stderr)

    def test_non_verify_does_not_set_guard_property_or_cache(self):
        for command in ('run', 'parse', 'typecheck'):
            data = self.result(command, 'a.qnt', QUINT_HOME='/original', JVM_ARGS='-Xmx1g')
            self.assertEqual(data['quint_home'], '/original')
            self.assertEqual(data['jvm_args'], '-Xmx1g')
        self.assertFalse((self.root / 'server.json').exists())

    def test_unsafe_jvm_options_are_rejected(self):
        for name in ('JVM_ARGS', 'JVM_GC_ARGS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS'):
            for value in ('-Dcom.google.protobuf.use_unsafe_pre22_gencode=true', '-Dcom.google.protobuf.error_on_unsafe_pre22_gencode=false', '-Dcom.google.protobuf.error_on_unsafe_pre22_gencode'):
                r = self.run_cli('verify', 'a.qnt', **{name: value})
                self.assertNotEqual(r.returncode, 0)
                self.assertIn('unsafe protobuf override', r.stderr)

    def test_java_argument_file_class_is_rejected_before_backend_start(self):
        options = self.root / 'unsafe options.txt'
        options.write_text('-Dcom.google.protobuf.error_on_unsafe_pre22_gencode=false\n'
                           '-Dcom.google.protobuf.use_unsafe_pre22_gencode=true\n')
        forms = {
            'absolute': '@' + str(options),
            'relative': '@jvm.options',
            'quoted-token': '"@' + str(options) + '"',
            'quoted-path': '@"' + str(options) + '"',
            'single-quoted': "'@" + str(options) + "'",
            'after-option': '-Xmx256m @' + str(options),
            'shell-expanded-value': '-Dprobe="x @jvm.options -Dtail=x"',
            'missing': '@' + str(self.root / 'missing.options'),
            'escaped-marker': '@@jvm.options',
        }
        for name in ('JVM_GC_ARGS', 'JVM_ARGS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS'):
            for shape, value in forms.items():
                with self.subTest(name=name, shape=shape):
                    r = self.run_cli('verify', 'a.qnt', **{name:value})
                    self.assertNotEqual(r.returncode, 0)
                    self.assertIn(name + ' contains a Java argument file', r.stderr)
                    self.assertEqual(r.stdout, '')
                    self.assertFalse((self.root / 'server.json').exists())

    def test_at_sign_in_property_value_is_not_an_argument_file(self):
        for name in ('JVM_ARGS', 'JVM_GC_ARGS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS'):
            with self.subTest(name=name):
                self.result('verify', 'a.qnt', **{name:'-Dcontact=owner@example.invalid'})
                self.server_stopped()

    def test_argument_file_requires_the_explicit_unsafe_bypass(self):
        for value in ('@jvm.options', '-XX:VMOptionsFile=jvm.options', '-XX:Flags=jvm.options'):
            with self.subTest(value=value):
                r = self.run_cli('verify', 'a.qnt', JVM_GC_ARGS=value,
                                 QUINT_ALLOW_VULNERABLE_APALACHE='1')
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertIn('bypassing the patched backend guard', r.stderr)
                self.assertFalse((self.root / 'server.json').exists())

    def test_named_java_option_file_loaders_are_rejected_before_backend_start(self):
        options = self.root / 'unsafe.vmoptions'
        options.write_text('-Dcom.google.protobuf.error_on_unsafe_pre22_gencode=false\n'
                           '-Dcom.google.protobuf.use_unsafe_pre22_gencode=true\n')
        for name in ('JVM_GC_ARGS', 'JVM_ARGS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS'):
            for loader in ('-XX:VMOptionsFile', '-XX:Flags'):
                forms = {
                    'absolute': loader + '=' + str(options),
                    'relative': loader + '=unsafe.vmoptions',
                    'quoted-path': loader + '="' + str(options) + '"',
                    'quoted-option': '"' + loader + '=' + str(options) + '"',
                    'single-quoted': "'" + loader + '=' + str(options) + "'",
                    'quoted-name': loader[:-1] + '"' + loader[-1] + '"=' + str(options),
                    'missing': loader + '=' + str(self.root / 'missing.vmoptions'),
                    'bare': loader,
                    'empty': loader + '=',
                    'after-option': '-Xmx256m ' + loader + '=' + str(options),
                    'shell-expanded-value': '-Dprobe="x ' + loader + '=unsafe.vmoptions -Dtail=x"',
                }
                for shape, value in forms.items():
                    with self.subTest(name=name, loader=loader, shape=shape):
                        r = self.run_cli('verify', 'a.qnt', **{name:value})
                        self.assertNotEqual(r.returncode, 0)
                        self.assertIn(name + ' contains a Java option-file loader', r.stderr)
                        self.assertEqual(r.stdout, '')
                        self.assertFalse((self.root / 'server.json').exists())

    def test_option_file_loader_text_in_property_value_is_not_a_loader(self):
        for name in ('JVM_ARGS', 'JVM_GC_ARGS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS'):
            for loader in ('-XX:VMOptionsFile', '-XX:Flags'):
                with self.subTest(name=name, loader=loader):
                    self.result('verify', 'a.qnt', **{name:'-Dprobe=' + loader + '=/missing.vmoptions'})
                    self.server_stopped()

    def test_quoted_jvm_property_class(self):
        forms = [
            '-Dcom.google.protobuf.error_on_unsafe_pre22_gen"code"=false',
            "-Dcom.google.protobuf.error_on_unsafe_pre22_gen'code'=false",
            '-Dcom.google.protobuf.error_on_unsafe_pre22_gencode="false"',
            "'-Dcom.google.protobuf.error_on_unsafe_pre22_gencode=false'",
            '-Dcom.google.protobuf.use_unsafe_pre22_gen"code"=true',
        ]
        for name in ('JVM_ARGS', 'JVM_GC_ARGS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS'):
            for value in forms:
                with self.subTest(name=name, value=value):
                    r = self.run_cli('verify', 'a.qnt', **{name:value})
                    self.assertNotEqual(r.returncode, 0)
                    self.assertIn('unsafe protobuf override', r.stderr)
        r = self.run_cli('verify', 'a.qnt', _JAVA_OPTIONS='"unterminated')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('invalid quoting', r.stderr)
        self.assertFalse((self.root / 'server.json').exists())

    def test_ambiguous_jvm_tokenization_class_is_refused(self):
        protected = '-Dcom.google.protobuf.error_on_unsafe_pre22_gencode=false'
        forms = ['-Dprobe=x' + '\\' + ' ' + protected,
                 '-Dprobe=x' + '\\' + '\t' + protected,
                 *('-Dprobe=x'+sep+protected for sep in ('\v', '\f', '\x85', '\xa0'))]
        for name in ('JVM_ARGS', 'JVM_GC_ARGS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS'):
            for value in forms:
                with self.subTest(name=name, value=repr(value)):
                    r = self.run_cli('verify', 'a.qnt', **{name:value})
                    self.assertNotEqual(r.returncode, 0)
                    self.assertIn('ambiguous JVM escapes or separators', r.stderr)
        self.assertFalse((self.root / 'server.json').exists())

    def test_shell_expanded_jvm_args_cannot_hide_override_in_quoted_value(self):
        protected = '-Dcom.google.protobuf.error_on_unsafe_pre22_gencode=false'
        for name in ('JVM_ARGS', 'JVM_GC_ARGS'):
            for quote in ('"', "'"):
                value = '-Dprobe='+quote+'x '+protected+quote
                r = self.run_cli('verify', 'a.qnt', **{name:value})
                self.assertNotEqual(r.returncode, 0)
                self.assertIn('unsafe protobuf override', r.stderr)
        self.assertFalse((self.root / 'server.json').exists())

    def test_endpoint_and_version_input_class(self):
        for option in ('--server-endpoint', '--serverEndpoint'):
            for value in ('', 'remote:9123', 'localhost:0', 'localhost:65536', 'localhost:nope'):
                for form in ((option, value), (option+'='+value,)):
                    r = self.run_cli('verify', 'a.qnt', *form)
                    self.assertNotEqual(r.returncode, 0, form)
        for option in ('--apalache-version', '--apalacheVersion'):
            for form in ((option, '0.63.0'), (option+'=0.63.0',)):
                self.assertNotEqual(self.run_cli('verify', 'a.qnt', *form).returncode, 0)
        for option in ('--no-server-endpoint', '--no-serverEndpoint', '--no-apalache-version', '--no-apalacheVersion'):
            self.assertNotEqual(self.run_cli('verify', 'a.qnt', option).returncode, 0)

    def test_version_spellings_and_repetition_become_one_pinned_option(self):
        forms = [('--apalache-version', '0.62.4'), ('--apalache-version=0.62.4',),
                 ('--apalacheVersion', '0.62.4'), ('--apalacheVersion=0.62.4',)]
        for form in forms + [forms[0] + forms[3]]:
            data = self.result('verify', 'a.qnt', *form)
            options = [arg for arg in data['raw_argv'] if arg.startswith(('--apalache-version', '--apalacheVersion'))]
            self.assertEqual(options, ['--apalache-version=0.62.4'])
            self.assertNotIn('0.62.4', data['raw_argv'])
            self.server_stopped()

    def test_occupied_endpoint_is_refused_without_touching_its_owner(self):
        with socket.socket() as unrelated:
            unrelated.bind(('127.0.0.1', 0)); unrelated.listen()
            r = self.run_cli('verify', 'a.qnt', '--server-endpoint', 'localhost:'+str(unrelated.getsockname()[1]))
            self.assertNotEqual(r.returncode, 0)
            self.assertFalse((self.root / 'server.json').exists())
            with socket.create_connection(unrelated.getsockname()): pass

    def test_signal_during_spawn_waits_for_pid_before_cleanup(self):
        import signal
        source = self.wrapper.read_text()
        delay = """        def delayed_popen(*args, **kwargs):
            process = subprocess.Popen(*args, **kwargs)
            print('SPAWN_RETURN_PENDING', flush=True)
            time.sleep(.5)
            return process
"""
        for assignment in ('server', 'client'):
            with self.subTest(assignment=assignment):
                changed = source.replace('        old_handlers = ', delay+'        old_handlers = ')
                changed = changed.replace(assignment+' = subprocess.Popen(', assignment+' = delayed_popen(')
                self.wrapper.write_text(changed)
                child = subprocess.Popen([str(self.wrapper), 'verify', 'a.qnt'], env={**self.env, 'FAKE_MODE':'wait'}, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                self.addCleanup(lambda p=child: p.poll() is None and p.kill())
                self.assertEqual(child.stdout.readline().strip(), 'SPAWN_RETURN_PENDING')
                child.send_signal(signal.SIGTERM)
                out, err = child.communicate(timeout=10)
                self.assertEqual(child.returncode, 143, err)
                self.server_stopped()
        self.wrapper.write_text(source)

    def test_signal_stops_owned_server(self):
        import signal
        child = subprocess.Popen([str(self.wrapper), 'verify', 'a.qnt'], env={**self.env, 'FAKE_MODE':'wait'}, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: child.poll() is None and child.kill())
        child.stdout.readline()
        child.send_signal(signal.SIGTERM)
        out, err = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 143, err)
        self.server_stopped()

    def test_startup_failure_is_not_a_verify_pass(self):
        r = self.run_cli('verify', 'a.qnt', FAKE_SERVER_EXIT='1')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('exited before listening', r.stderr)
        self.server_stopped()

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

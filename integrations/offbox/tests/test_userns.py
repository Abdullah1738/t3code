"""Host userns persistence and the acceptance probe's uid, verdict and cleanup."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


SERVER = Path(__file__).resolve().parents[1] / "server"
ACCEPTANCE = SERVER / "home/acceptance.sh"


class UsernsConfig(unittest.TestCase):
    def test_installer_and_stick_disable_only_the_extra_userns_restriction(self):
        installer = (SERVER / "install-host.sh").read_text()
        match = re.search(
            r"cat > /etc/sysctl.d/90-offbox-userns.conf <<'EOF'\n(.*?)\nEOF",
            installer, re.S,
        )
        self.assertIsNotNone(match)
        stick = (SERVER / "home/stick/offbox/target/rootfs/etc/sysctl.d/90-offbox-userns.conf").read_text()
        settings = lambda text: [line.strip() for line in text.splitlines()
                                 if line.strip() and not line.startswith("#")]
        expected = ["kernel.apparmor_restrict_unprivileged_userns = 0"]
        self.assertEqual(settings(match[1]), expected)
        self.assertEqual(settings(stick), expected)
        self.assertLess(installer.index(match[0]), installer.index("sysctl -q --system"))
        self.assertIn("security.nesting=true", installer)
        self.assertNotIn("security.privileged=true", installer)


class UsernsAcceptance(unittest.TestCase):
    def run_probe(self, fail_at="", uid="0", option="--userns"):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log = root / "calls.jsonl"
            incus = root / "incus"
            incus.write_text("""#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['PROBE_LOG'], 'a') as f:
    f.write(json.dumps(args) + '\\n')
if args[0] in ('init', 'exec'):
    assert sys.stdin.read() == '', 'Incus must not consume the streamed acceptance script'
if args[0] == 'exec':
    assert args[2:] == ['--user', '1000', '--group', '1000', '--cwd', '/', '--', 'sh', '-c',
        '[ "$(id -u)" = 1000 ] && exec unshare --user --map-root-user --net --mount true'], args
if args[0] == os.environ.get('FAIL_AT'):
    print('injected ' + args[0] + ' failure', file=sys.stderr)
    sys.exit(1)
""")
            incus.chmod(0o755)
            for name, body in {
                "id": 'echo "$PROBE_UID"',
                "cat": 'echo 9ee1f823-46de-47be-94e8-2a20a0a88861',
            }.items():
                path = root / name
                path.write_text("#!/bin/sh\n" + body + "\n")
                path.chmod(0o755)
            result = subprocess.run(
                ["bash", "-s", "--", option], input=ACCEPTANCE.read_text(), capture_output=True, text=True,
                env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                     "PROBE_LOG": str(log), "FAIL_AT": fail_at, "PROBE_UID": uid},
            )
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            return result, calls

    def test_success_probes_uid_1000_and_removes_only_its_ephemeral_box(self):
        result, calls = self.run_probe()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PASS box uid 1000", result.stdout)
        self.assertEqual([c[0] for c in calls], ["init", "start", "exec", "delete"])
        box = calls[0][2]
        self.assertTrue(box.startswith("offbox-acceptance-userns-"))
        self.assertEqual(calls[0], ["init", "offbox-base", box, "--ephemeral", "-p", "default", "-p", "offbox"])
        self.assertEqual(calls[1], ["start", box])
        self.assertEqual(calls[2][1], box)
        self.assertEqual(calls[3], ["delete", "--force", box])

    def test_namespace_denial_fails_acceptance_and_cleans_up(self):
        result, calls = self.run_probe("exec")
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL box uid 1000", result.stdout)
        self.assertNotIn("PASS", result.stdout)
        self.assertEqual(calls[-1][0], "delete")

    def test_namespace_only_alias_has_the_same_verdict_and_cleanup(self):
        for option in ("--userns", "--userns-only"):
            for fail_at, expected in (("", 0), ("exec", 1)):
                with self.subTest(option=option, fail_at=fail_at):
                    result, calls = self.run_probe(fail_at, option=option)
                    self.assertEqual(result.returncode, expected, result.stderr)
                    self.assertEqual([c[0] for c in calls], ["init", "start", "exec", "delete"])
                    self.assertEqual(len(result.stdout.splitlines()), 1)
                    self.assertTrue(result.stdout.startswith("PASS" if expected == 0 else "FAIL"))

    def test_start_failure_cleans_up_and_fails(self):
        result, calls = self.run_probe("start")
        self.assertEqual(result.returncode, 1)
        self.assertEqual([c[0] for c in calls], ["init", "start", "delete"])

    def test_init_failure_does_not_delete_a_box_it_did_not_create(self):
        result, calls = self.run_probe("init")
        self.assertEqual(result.returncode, 1)
        self.assertEqual([c[0] for c in calls], ["init"])

    def test_cleanup_failure_is_not_a_pass(self):
        result, calls = self.run_probe("delete")
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("PASS", result.stdout)
        self.assertEqual(calls[-1][0], "delete")

    def test_non_root_host_invocation_does_not_create_a_box(self):
        result, calls = self.run_probe(uid="1000")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()

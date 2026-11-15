"""Daily-update policy, stale-service snapshots and the config-only rollout path."""
import datetime
import importlib.machinery
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HOME = Path(__file__).resolve().parents[1] / "server/home"
ROOTFS = HOME / "stick/offbox/target/rootfs"
CONF = Path("etc/needrestart/conf.d/50-offbox.conf")
WRITER = Path("usr/local/sbin/offbox-restart-pending")
APT = Path("etc/apt/apt.conf.d/52offbox-unattended")
HOOK = Path("etc/apt/apt.conf.d/zz-offbox-restart-pending")
sys.dont_write_bytecode = True
loader = importlib.machinery.SourceFileLoader("restart_pending", str(ROOTFS / WRITER))
spec = importlib.util.spec_from_loader(loader.name, loader)
writer = importlib.util.module_from_spec(spec)
loader.exec_module(writer)


class UpdatePolicy(unittest.TestCase):
    def test_perl_parses_and_protects_every_run_path_unit_but_not_other_services(self):
        result = subprocess.run(["perl", "-c", str(ROOTFS / CONF)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        protected = ["incus.service", "incus.socket", "incus-lxcfs.service", "incus-user.service",
                     "lxcfs.service", "boatd.service", "boatd-cmd-bx-test-1001.service", "boatd-snap@daily.service",
                     "boatd-scrub.service", "zfs-zed.service", "zfs-import-cache.service", "mullvad-daemon.service",
                     "offbox-exit-proxy.service", "offbox-vpn-guard.service", "offbox-vpn-guard-release.service",
                     "offbox-vpn-exit-check.service", "offbox-exit-proxy-health.service", "offbox-watchdog.service",
                     "offbox-boot-health.service", "offbox-boot-report.service", "offbox-rtcwake.service",
                     "offbox-rtcwake-shutdown.service", "offbox-tailscale-join.service", "offbox-emergency-agent.service"]
        unrelated = ["ssh.service", "cron.service", "systemd-journald.service", "notboatd.service"]
        # Evaluate the real Perl regex keys, rather than searching for prefix text in comments.
        program = '''our %nrconf; my $file = shift; do $file; die $@ if $@;
for my $unit (@ARGV) {
  my $restart = 1;
  for my $re (keys %{$nrconf{override_rc}}) {
    if ($unit =~ /$re/) { $restart = $nrconf{override_rc}->{$re}; last; }
  }
  print "$unit=$restart\\n";
}'''
        result = subprocess.run(["perl", "-e", program, str(ROOTFS / CONF), *protected, *unrelated],
                                capture_output=True, text=True, check=True)
        expected = [f"{u}=0" for u in protected] + [f"{u}=1" for u in unrelated]
        self.assertEqual(result.stdout.splitlines(), expected)

    def test_apt_hook_is_list_only_and_cannot_fail_dpkg(self):
        text = (ROOTFS / APT).read_text()
        self.assertIn('APT::Periodic::Unattended-Upgrade "1";', text)
        self.assertIn('Unattended-Upgrade::Automatic-Reboot "false";', text)
        hook = '/usr/local/sbin/offbox-restart-pending || true'
        self.assertIn(f'DPkg::Post-Invoke {{ "{hook}"; }};', (ROOTFS / HOOK).read_text())
        self.assertNotIn('Package-Blacklist', text)  # Zabbly is outside the allowed origins.
        self.assertEqual(subprocess.run(["sh", "-c", hook.replace('/usr/local/sbin/offbox-restart-pending',
                                                                  '(exit 42)')]).returncode, 0)
        if shutil.which("apt-config"):
            result = subprocess.run(["apt-config", "-c", str(ROOTFS / HOOK), "dump"],
                                    text=True, capture_output=True, check=True)
            self.assertIn(hook, result.stdout)

    @unittest.skipUnless(shutil.which("apt-config"), "APT config parser requires Linux")
    def test_snapshot_runs_after_ubuntu_service_restart_hook(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            parts = directory / "parts"
            parts.mkdir()
            for path in (APT, HOOK):
                shutil.copyfile(ROOTFS / path, parts / path.name)
            (parts / "99needrestart").write_text('DPkg::Post-Invoke {"/test/ubuntu-needrestart";};\n')
            config = directory / "apt.conf"
            config.write_text(f'Dir::Etc::parts "{parts}";\nDir::Etc::main "/dev/null";\n')
            result = subprocess.run(["apt-config", "dump"], capture_output=True, text=True, check=True,
                                    env={**os.environ, "APT_CONFIG": str(config)})
            hooks = re.findall(r'^DPkg::Post-Invoke:: "(.*)";$', result.stdout, re.MULTILINE)
            self.assertEqual(hooks, ["/test/ubuntu-needrestart", "/usr/local/sbin/offbox-restart-pending || true"])

    def test_batch_output_forms(self):
        for output, expected in [
            ("NEEDRESTART-VER: 3.6\n", []),
            ("NEEDRESTART-VER: 3.6\nNEEDRESTART-SVC: boatd.service\n", ["boatd.service"]),
            ("NEEDRESTART-VER: 3.6\r\nNEEDRESTART-SVC: incus.service\r\n", ["incus.service"]),
            ("NEEDRESTART-VER: 3.6\nNEEDRESTART-SVC:\tssh.service \t\n", ["ssh.service"]),
            ("NEEDRESTART-VER: 3.6\nNEEDRESTART-SVC: zfs-zed.service\nNEEDRESTART-SVC: boatd-cmd-bx-test-1.service\n"
             "NEEDRESTART-SVC: zfs-zed.service\nNEEDRESTART-CONT: LXC bx-test\nNEEDRESTART-KSTA: 1\n",
             ["boatd-cmd-bx-test-1.service", "zfs-zed.service"]),
        ]:
            with self.subTest(output=output):
                self.assertEqual(writer.services(output), expected)
        for output in ("", "scan failed\n", "NEEDRESTART-VER: 3.6\nNEEDRESTART-SVC:\n"):
            with self.subTest(invalid=output), self.assertRaises(ValueError):
                writer.services(output)

    def test_records_timestamp_and_list_atomically_and_clears_resolved_services(self):
        with tempfile.TemporaryDirectory() as tmp:
            record = Path(tmp) / "offbox/restart-pending.json"
            output = "NEEDRESTART-VER: 3.6\nNEEDRESTART-SVC: incus-lxcfs.service\n"
            result = subprocess.CompletedProcess([], 0, output, "")
            with patch.object(writer.subprocess, "run", return_value=result) as run:
                writer.record(record)
            self.assertEqual(run.call_args.args[0], ["/usr/sbin/needrestart", "-b", "-r", "l"])
            self.assertTrue(run.call_args.kwargs["check"])
            data = json.loads(record.read_text())
            self.assertEqual(data["services"], ["incus-lxcfs.service"])
            stamp = datetime.datetime.fromisoformat(data["checkedAt"])
            self.assertEqual(stamp.utcoffset(), datetime.timedelta(0))
            self.assertEqual(record.stat().st_mode & 0o777, 0o644)
            self.assertEqual(list(record.parent.iterdir()), [record])
            result.stdout = "NEEDRESTART-VER: 3.6\n"
            with patch.object(writer.subprocess, "run", return_value=result):
                writer.record(record)
            self.assertEqual(json.loads(record.read_text())["services"], [])

    def test_scan_and_atomic_write_failures_preserve_the_previous_record(self):
        failures = [subprocess.CalledProcessError(1, "needrestart"),
                    subprocess.TimeoutExpired("needrestart", 120), FileNotFoundError("needrestart")]
        with tempfile.TemporaryDirectory() as tmp:
            record = Path(tmp) / "restart-pending.json"
            record.write_text('{"services":["boatd.service"]}\n')
            before = record.read_bytes()
            for error in failures:
                with self.subTest(error=error), patch.object(writer.subprocess, "run", side_effect=error):
                    with self.assertRaises(type(error)):
                        writer.record(record)
                    self.assertEqual(record.read_bytes(), before)
            for output in ("", "NEEDRESTART-VER: 3.6\nNEEDRESTART-SVC:\n"):
                with patch.object(writer.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output, "")):
                    with self.assertRaises(ValueError):
                        writer.record(record)
                    self.assertEqual(record.read_bytes(), before)
            result = subprocess.CompletedProcess([], 0, "NEEDRESTART-VER: 3.6\n", "")
            with patch.object(writer.subprocess, "run", return_value=result), patch.object(writer.os, "replace", side_effect=OSError):
                with self.assertRaises(OSError):
                    writer.record(record)
            self.assertEqual(record.read_bytes(), before)
            self.assertEqual(list(record.parent.iterdir()), [record])

    def test_existing_host_installer_only_copies_policy_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            forbidden = root / "bin"
            forbidden.mkdir()
            log = root / "unexpected"
            for name in ("apt-get", "systemctl", "incus", "tailscale", "needrestart"):
                stub = forbidden / name
                stub.write_text(f'#!/bin/sh\necho "$0 $*" >> "{log}"\nexit 99\n')
                stub.chmod(0o755)
            env = {**os.environ, "PATH": str(forbidden) + os.pathsep + os.environ["PATH"]}
            dest = root / "host"
            for _ in range(2):
                result = subprocess.run(["bash", str(HOME / "install-update-policy.sh"), str(dest)],
                                        env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(sorted(p.relative_to(dest) for p in dest.rglob('*') if p.is_file()),
                                 sorted([CONF, WRITER, APT, HOOK]))
                for path, mode in ((CONF, 0o644), (WRITER, 0o755), (APT, 0o644), (HOOK, 0o644)):
                    self.assertEqual((dest / path).read_bytes(), (ROOTFS / path).read_bytes())
                    self.assertEqual((dest / path).stat().st_mode & 0o777, mode)
            self.assertFalse(log.exists())

    def test_invalid_perl_payload_does_not_touch_destination(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            for relative in (CONF, WRITER, APT, HOOK):
                dest = home / "stick/offbox/target/rootfs" / relative
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOTFS / relative, dest)
            shutil.copyfile(HOME / "install-update-policy.sh", home / "install-update-policy.sh")
            (home / "stick/offbox/target/rootfs" / CONF).write_text("this is not valid Perl {\n")
            target = Path(tmp) / "host"
            result = subprocess.run(["bash", str(home / "install-update-policy.sh"), str(target)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(target.exists())

    def test_update_policy_entry_point_exits_before_any_provisioning(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = Path(tmp)
            shutil.copyfile(HOME.parent / "install-host.sh", server / "install-host.sh")
            (server / "home").mkdir()
            sentinel = server / "called"
            (server / "home/install-update-policy.sh").write_text(f'#!/bin/sh\ntouch "{sentinel}"\n')
            result = subprocess.run(["bash", str(server / "install-host.sh"), "update-policy"], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(sentinel.exists())


if __name__ == "__main__":
    unittest.main()

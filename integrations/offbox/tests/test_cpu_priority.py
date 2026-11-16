"""Exercise the priority-only installer without touching host services or Incus."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SERVER = Path(__file__).resolve().parents[1] / "server"


class CpuPriority(unittest.TestCase):
    def test_persistent_weights_are_idempotent_and_applied_without_restart_or_quota(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            calls = root / "calls"
            systemctl = root / "systemctl"
            systemctl.write_text("""#!/usr/bin/env python3
import json, os, sys
with open(os.environ['CALLS'], 'a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\\n')
if os.environ.get('FAIL_UNIT') in sys.argv[1:]:
    sys.exit(42)
""")
            systemctl.chmod(0o755)
            env = {**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                   "SYSTEMD_UNIT_DIR": str(root / "units"), "CALLS": str(calls)}
            units = ("system.slice", "boatd.service", "tailscaled.service", "ssh.service", "incus.service")
            expected = [["daemon-reload"]] + [["set-property", "--runtime", u, "CPUWeight=1000"] for u in units]
            before = None
            for _ in range(2):
                result = subprocess.run(["bash", str(SERVER / "install-host.sh"), "cpu-priority"],
                                        env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                files = sorted((root / "units").rglob("*.conf"))
                self.assertEqual(len(files), 6)
                for file in files:
                    unit = file.parent.name.removesuffix(".d")
                    section = "Slice" if unit == "system.slice" else "Service"
                    weight = 100 if unit == "boatd-cmd-.service" else 1000
                    self.assertEqual(file.read_text(), f"[{section}]\nCPUWeight={weight}\n")
                    self.assertEqual(file.stat().st_mode & 0o777, 0o644)
                current = {str(f): (f.read_bytes(), f.stat().st_mtime_ns) for f in files}
                if before is not None:
                    self.assertEqual(current, before)
                before = current
            self.assertEqual([json.loads(x) for x in calls.read_text().splitlines()], expected * 2)
            env["FAIL_UNIT"] = "tailscaled.service"
            result = subprocess.run(["bash", str(SERVER / "install-host.sh"), "cpu-priority"],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 42)
            self.assertEqual([json.loads(x) for x in calls.read_text().splitlines()][-4:], expected[:4])


if __name__ == "__main__":
    unittest.main()

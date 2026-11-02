import os
from pathlib import Path
import subprocess
import sys
import unittest


SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
import engine


IDENTITY = "child-identity"
PIN = "child-pin"
INHERITED = {
    "HARNESS_HOOKS_COMMAND_IDENTITY": "parent-identity",
    "HARNESS_COORD_APPROVED": "parent-coord",
    "AGENT_GUARD_APPROVED": "parent-guard",
}
CHILD = {
    "HARNESS_HOOKS_COMMAND_IDENTITY": IDENTITY,
    "HARNESS_COORD_APPROVED": PIN,
    "AGENT_GUARD_APPROVED": PIN,
}
SHELLS = ("/bin/bash", "/bin/zsh")


class ShellFollowupTests(unittest.TestCase):
    def run_shell(self, shell, script, env):
        return subprocess.run([shell, "-c", script], env={**os.environ, **env},
                              text=True, capture_output=True, timeout=5)

    def test_return_to_same_function_keeps_export_attribute_untouched(self):
        for shell in SHELLS:
            with self.subTest(shell=shell):
                command = "return 7"
                wrapped = engine._command_with_context(command, IDENTITY, PIN)
                script = ("f() { local HARNESS_HOOKS_COMMAND_IDENTITY=before; "
                          "export HARNESS_HOOKS_COMMAND_IDENTITY;\n" + wrapped + "\n}\n"
                          "f\nprintf 'status=%s identity=%s\\n' \"$?\" \"$HARNESS_HOOKS_COMMAND_IDENTITY\"\n")
                actual = self.run_shell(shell, script, INHERITED)
                self.assertEqual(actual.stdout, "status=7 identity=parent-identity\n")

    def test_original_state_status_and_syntax(self):
        for shell in SHELLS:
            for command in (
                "export SAMPLE='changed value'; set -- 'a b' c; false",
                "export SAMPLE='changed value'; set -- 'a b' c; true",
                "printf 'unterminated",
                "cat <<'END'\nline\nEND\nfalse",
            ):
                with self.subTest(shell=shell, command=command):
                    raw = self.run_shell(shell, command, CHILD)
                    wrapped = self.run_shell(shell, engine._command_with_context(command, IDENTITY, PIN), INHERITED)
                    self.assertEqual((wrapped.returncode, wrapped.stdout), (raw.returncode, raw.stdout), wrapped.stderr)


if __name__ == "__main__":
    unittest.main()

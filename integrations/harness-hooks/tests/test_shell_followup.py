import os
from pathlib import Path
import subprocess
import sys
import unittest


SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
import engine


IDENTITY = "child-identity"
INHERITED = {
    "HARNESS_HOOKS_COMMAND_IDENTITY": "parent-identity",
}
CHILD = {
    "HARNESS_HOOKS_COMMAND_IDENTITY": IDENTITY,
}
SHELLS = ("/bin/bash", "/bin/zsh")


class ShellFollowupTests(unittest.TestCase):
    def run_shell(self, shell, script, env):
        child_env = {k: v for k, v in os.environ.items() if k not in ("BASH_ENV", "ENV")}
        return subprocess.run([shell, "-c", script], env={**child_env, **env},
                              text=True, capture_output=True, timeout=5)

    def test_deferred_handlers_keep_the_registration_identity(self):
        for shell in SHELLS:
            actions = ["trap 'printf \"deferred=%s\\n\" \"$HARNESS_HOOKS_COMMAND_IDENTITY\"' EXIT"]
            if shell.endswith("zsh"):
                actions.append('TRAPEXIT() { printf "deferred=%s\\n" "$HARNESS_HOOKS_COMMAND_IDENTITY"; }')
            for action in actions:
                with self.subTest(shell=shell, action=action):
                    first = engine._command_with_context(action, IDENTITY)
                    sibling = engine._command_with_context("printf sibling", "sibling-identity")
                    actual = self.run_shell(shell, first + "\n" + sibling + "\nexit 19", INHERITED)
                    self.assertEqual((actual.returncode, actual.stdout, actual.stderr),
                                     (19, "siblingdeferred=child-identity\n", ""))

    def test_return_to_same_function_keeps_export_attribute_untouched(self):
        for shell in SHELLS:
            with self.subTest(shell=shell):
                command = "return 7"
                wrapped = engine._command_with_context(command, IDENTITY)
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
                    wrapped = self.run_shell(shell, engine._command_with_context(command, IDENTITY), INHERITED)
                    self.assertEqual((wrapped.returncode, wrapped.stdout), (raw.returncode, raw.stdout), wrapped.stderr)


if __name__ == "__main__":
    unittest.main()

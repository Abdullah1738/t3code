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

    @unittest.expectedFailure
    def test_preexisting_err_trap_runs_once_per_original_failure(self):
        commands = (
            "false <<'EOF'\npayload\nEOF",
            "false <<'EOF'\npayload",
            "cat <<'EOF'\npayload\nEOF\nfalse",
            "false; cat <<'EOF'\npayload\nEOF\nfalse",
        )
        prefix = ("trap 'printf \"trap=%s identity=%s pin=%s\\n\" \"$?\" "
                  "\"$HARNESS_HOOKS_COMMAND_IDENTITY\" \"$HARNESS_COORD_APPROVED\"' ERR\n")
        suffix = ("\nresult=$?; trap - ERR; "
                  "printf 'status=%s identity=%s coord=%s guard=%s\\n' \"$result\" "
                  "\"$HARNESS_HOOKS_COMMAND_IDENTITY\" \"$HARNESS_COORD_APPROVED\" "
                  "\"$AGENT_GUARD_APPROVED\"\n")
        for shell in SHELLS:
            for command in commands:
                with self.subTest(shell=shell, command=command):
                    raw = self.run_shell(shell, prefix + command, CHILD)
                    wrapped = engine._command_with_context(command, IDENTITY, PIN)
                    actual = self.run_shell(shell, prefix + wrapped + suffix, INHERITED)
                    self.assertEqual(actual.returncode, 0, actual.stderr)
                    self.assertEqual(actual.stdout, raw.stdout +
                                     f"status={raw.returncode} identity=parent-identity "
                                     "coord=parent-coord guard=parent-guard\n")

    @unittest.expectedFailure
    def test_return_from_caller_restores_inherited_context_without_fallthrough(self):
        for shell in SHELLS:
            for command in (
                "printf 'inside=%s|%s|%s\\n' \"$HARNESS_HOOKS_COMMAND_IDENTITY\" "
                "\"$HARNESS_COORD_APPROVED\" \"$AGENT_GUARD_APPROVED\"; export SAMPLE='x y'; return 7",
                "cat <<'EOF'\nquoted $HOME\nEOF\nexport SAMPLE='x y'; return 7",
                "eval 'return 7'",
            ):
                with self.subTest(shell=shell, command=command):
                    wrapped = engine._command_with_context(command, IDENTITY, PIN)
                    suffix = ("\nprintf 'fallthrough\\n'\n}\nouter\nresult=$?\n"
                              "printf 'status=%s identity=%s coord=%s guard=%s sample=%s\\n' "
                              "\"$result\" \"$HARNESS_HOOKS_COMMAND_IDENTITY\" "
                              "\"$HARNESS_COORD_APPROVED\" \"$AGENT_GUARD_APPROVED\" \"${SAMPLE-unset}\"\n")
                    raw = self.run_shell(shell, "outer() {\n" + command + suffix, CHILD)
                    actual = self.run_shell(shell, "outer() {\n" + wrapped + suffix, INHERITED)
                    self.assertEqual(actual.returncode, 0, actual.stderr)
                    self.assertEqual(actual.stdout, raw.stdout.replace(
                        "identity=child-identity coord=child-pin guard=child-pin",
                        "identity=parent-identity coord=parent-coord guard=parent-guard"))

    @unittest.expectedFailure
    def test_return_preserves_caller_locals_and_export_attributes(self):
        for shell in SHELLS:
            for local_setup in (
                "local HARNESS_HOOKS_COMMAND_IDENTITY=outer-local; "
                "local HARNESS_COORD_APPROVED=outer-coord; "
                "local AGENT_GUARD_APPROVED=outer-guard",
                "local HARNESS_HOOKS_COMMAND_IDENTITY=outer-local; "
                "local HARNESS_COORD_APPROVED=outer-coord; "
                "local AGENT_GUARD_APPROVED=outer-guard; "
                "export HARNESS_HOOKS_COMMAND_IDENTITY HARNESS_COORD_APPROVED AGENT_GUARD_APPROVED",
            ):
                with self.subTest(shell=shell, local_setup=local_setup):
                    command = "return 7"
                    wrapped = engine._command_with_context(command, IDENTITY, PIN)
                    prefix = ("outer() {\n" + local_setup + "\ninner() {\n")
                    suffix = ("\nprintf 'fallthrough\\n'\n}\ninner\nresult=$?\n"
                              "printf 'status=%s identity=%s coord=%s guard=%s\\n' \"$result\" "
                              "\"$HARNESS_HOOKS_COMMAND_IDENTITY\" \"$HARNESS_COORD_APPROVED\" "
                              "\"$AGENT_GUARD_APPROVED\"\n"
                              "env | grep -E '^(HARNESS_HOOKS_COMMAND_IDENTITY|HARNESS_COORD_APPROVED|AGENT_GUARD_APPROVED)=' | sort\n"
                              "}\nouter\n")
                    raw = self.run_shell(shell, prefix + command + suffix, INHERITED)
                    actual = self.run_shell(shell, prefix + wrapped + suffix, INHERITED)
                    self.assertEqual((actual.returncode, actual.stdout, actual.stderr),
                                     (raw.returncode, raw.stdout, raw.stderr))

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

    @unittest.expectedFailure
    def test_return_with_originally_unset_context(self):
        env = {key: value for key, value in os.environ.items() if key not in INHERITED}
        for shell in SHELLS:
            with self.subTest(shell=shell):
                wrapped = engine._command_with_context("return 7", IDENTITY, PIN)
                script = ("f() {\n" + wrapped + "\n}\nf\nresult=$?\n"
                          "printf '%s|%s|%s|%s\\n' \"$result\" "
                          "\"${HARNESS_HOOKS_COMMAND_IDENTITY-unset}\" "
                          "\"${HARNESS_COORD_APPROVED-unset}\" \"${AGENT_GUARD_APPROVED-unset}\"\n")
                actual = subprocess.run([shell, "-c", script], env=env, text=True,
                                        capture_output=True, timeout=5)
                self.assertEqual((actual.returncode, actual.stdout, actual.stderr),
                                 (0, "7|unset|unset|unset\n", ""))

    @unittest.expectedFailure
    def test_normal_completion_preserves_nonexported_caller_local(self):
        for shell in SHELLS:
            with self.subTest(shell=shell):
                wrapped = engine._command_with_context(":", IDENTITY, PIN)
                script = ("f() { local HARNESS_HOOKS_COMMAND_IDENTITY=local-only;\n" + wrapped +
                          "\nexport -p | grep HARNESS_HOOKS_COMMAND_IDENTITY || :\n}\nf\n")
                env = {key: value for key, value in os.environ.items() if key not in INHERITED}
                actual = subprocess.run([shell, "-c", script], env=env, text=True,
                                        capture_output=True, timeout=5)
                self.assertEqual(actual.stdout, "", actual.stderr)

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

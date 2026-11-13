"""Keep offline fixtures independent of the shell and installed home backend."""
import os
from pathlib import Path
from unittest.mock import patch


LEAKY_VARS = (
    "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "ROBOB_HARNESS",
    "HARNESS_HOOKS_COMMAND_IDENTITY", "HARNESS_HOOKS_SRC", "BASH_ENV", "ENV",
)


def clean_env(**overrides):
    env = {key: value for key, value in os.environ.items() if key not in LEAKY_VARS}
    env.update(overrides)
    return env


def isolate_home(stack, root, *, guard_failover=True):
    from offbox_lib import common, home

    root = Path(root) / "home-backend"
    for name, filename in (("SERVER_CFG", "server.json"), ("BACKEND_STATE", "backend-state.json"),
                           ("BACKEND_PATH", "backend"), ("HOME_FAILURES", "home-failures.jsonl")):
        stack.enter_context(patch.object(common, name, root / filename))
    stack.enter_context(patch.object(common, "_BACKEND", None))
    if guard_failover:
        stack.enter_context(patch.object(home, "probe", return_value=None))
        stack.enter_context(patch.object(home, "fail_over", side_effect=AssertionError(
            "test reached home.fail_over (would exec over the test process)")))

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


def isolate_boat(stack):
    from offbox_lib import api, capacity

    # These values are cached at import, before a fixture can pin OFFBOX_BACKEND.
    for name, value in (("BACKEND", "boat"), ("NAME", "boat"), ("API", "https://boat.dev/api/v1"),
                        ("KEY_SERVICE", "boat-api"), ("KEY_ACCOUNT", "ardud"), ("_KEY", None)):
        stack.enter_context(patch.object(api, name, value))
    stack.enter_context(patch.object(capacity, "WINDOWS",
                                    ((60, "MINUTE", 25), (3600, "HOUR", 180), (86400, "DAY", 760))))


def isolate_home(stack, root, *, guard_failover=True):
    from offbox_lib import common, home, lease

    # Offline pool fixtures have no remote commands unless the test supplies that boundary.
    stack.enter_context(patch.object(lease, 'remote_commands_busy', return_value=False))

    root = Path(root) / "home-backend"
    for name, filename in (("SERVER_CFG", "server.json"), ("BACKEND_STATE", "backend-state.json"),
                           ("BACKEND_PATH", "backend"), ("HOME_FAILURES", "home-failures.jsonl")):
        stack.enter_context(patch.object(common, name, root / filename))
    stack.enter_context(patch.object(common, "_BACKEND", None))
    if guard_failover:
        stack.enter_context(patch.object(home, "probe", return_value=None))
        stack.enter_context(patch.object(home, "fail_over", side_effect=AssertionError(
            "test reached home.fail_over (would exec over the test process)")))

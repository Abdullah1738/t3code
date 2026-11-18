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


def require_shim_interpreter(test, shim):
    shim = Path(shim)
    with shim.open() as source:
        header = source.readline().strip()
    test.assertTrue(header.startswith("#!") and header[2:].strip(), f"{shim} has no shebang")
    interpreter = header[2:].split()[0]
    if not os.access(interpreter, os.X_OK):
        test.skipTest(f"blockers/{shim.name} needs {interpreter}, which this box doesn't have "
                      "(offbox-base built before Offbox #206; rebuild is #265; or use --template generic)")


def isolate_boat(stack):
    from offbox_lib import api, capacity, box_disk

    # Disk probes are guest I/O, just like the API boundary. Disk tests opt back in explicitly.
    stack.enter_context(patch.object(box_disk, "measure", return_value={}))
    stack.enter_context(patch.object(box_disk, "reclaim", return_value={}))
    stack.enter_context(patch.object(box_disk, "safe_to_stop", return_value=False))

    # These values are cached at import, before a fixture can pin OFFBOX_BACKEND.
    for name, value in (("BACKEND", "boat"), ("NAME", "boat"), ("API", "https://boat.dev/api/v1"),
                        ("KEY_SERVICE", "boat-api"), ("KEY_ACCOUNT", "ardud"), ("_KEY", None)):
        stack.enter_context(patch.object(api, name, value))
    stack.enter_context(patch.object(capacity, "WINDOWS",
                                    ((60, "MINUTE", 25), (3600, "HOUR", 180), (86400, "DAY", 760))))


def isolate_home(stack, root, *, guard_failover=True):
    from offbox_lib import api, common, home

    # Offline pool fixtures have no remote commands unless the test supplies that boundary.
    stack.enter_context(patch.object(api, 'box_protection', return_value=
        dict(ok=True, pin=dict(active=False, holder=None, until=None), holds=[])))

    stack.enter_context(patch.dict(os.environ, OFFBOX_TEST="1", OFFBOX_LOG_DIR=str(Path(root) / "tool-logs")))
    root = Path(root) / "home-backend"
    for name, filename in (("SERVER_CFG", "server.json"), ("BACKEND_STATE", "backend-state.json"),
                           ("BACKEND_PATH", "backend"), ("HOME_FAILURES", "home-failures.jsonl")):
        stack.enter_context(patch.object(common, name, root / filename))
    stack.enter_context(patch.object(common, "_BACKEND", None))
    stack.enter_context(patch.object(home, "slow_read_reachable", return_value=False))
    if guard_failover:
        stack.enter_context(patch.object(home, "probe", return_value=None))
        stack.enter_context(patch.object(home, "fail_over", side_effect=AssertionError(
            "test reached home.fail_over (would exec over the test process)")))

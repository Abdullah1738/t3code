"""Client helpers shared by server tests without exposing the client test directory."""
import importlib.util
from pathlib import Path
import sys

CLIENT_TESTS = Path(__file__).resolve().parents[1] / "skill" / "scripts" / "tests"


def _load(name):
    qualified = "offbox_client_" + name
    if qualified in sys.modules:
        return sys.modules[qualified]
    spec = importlib.util.spec_from_file_location(qualified, CLIENT_TESTS / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    path = sys.path[:]
    previous_capacity = sys.modules.get("test_capacity")
    if name == "test_exit_and_queue":
        # FakeClock's module imports Isolated by its original name; share the cached fixture.
        sys.modules["test_capacity"] = _load("test_capacity")
    sys.modules[qualified] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        del sys.modules[qualified]
        raise
    finally:
        sys.path[:] = path
        if name == "test_exit_and_queue":
            if previous_capacity is None:
                sys.modules.pop("test_capacity", None)
            else:
                sys.modules["test_capacity"] = previous_capacity
    return module


Isolated = _load("test_capacity").Isolated
FakeClock = _load("test_exit_and_queue").FakeClock

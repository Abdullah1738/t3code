"""Keep direct pytest invocations and their subprocesses out of live tool logs."""
import pytest


@pytest.fixture(autouse=True)
def tool_logs(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFBOX_TEST", "1")
    monkeypatch.setenv("OFFBOX_LOG_DIR", str(tmp_path / "tool-logs"))

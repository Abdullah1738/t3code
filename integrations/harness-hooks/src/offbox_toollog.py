"""Use offbox's shared logger; no policy or logging implementation lives in the hook."""
import importlib.util
from pathlib import Path

_candidates = [Path(__file__).resolve().parents[2] / "offbox/skill/scripts/toollog.py",
               Path.home() / ".config/opencode/skills/remote-compute/scripts/toollog.py"]
for _path in _candidates:
    if _path.is_file():
        _spec = importlib.util.spec_from_file_location("_offbox_toollog", _path)
        _mod = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_mod)
        emit = _mod.emit
        break
else:
    def emit(*args, **kwargs):
        pass

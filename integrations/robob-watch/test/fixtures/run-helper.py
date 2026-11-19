"""Run CLI behavior fixtures without the optional logger's background stderr pipe.

The logger's own process-boundary coverage lives in test_helper_logging.py.
"""
import os

os.environ["ROBOB_TEST"] = "1"
from contextlib import nullcontext
from pathlib import Path
import runpy
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "helpers"))
import toollog

sys.argv = sys.argv[1:]
with patch.object(toollog, "_capture_stderr", lambda _cause: nullcontext()):
    runpy.run_path(sys.argv[0], run_name="__main__")

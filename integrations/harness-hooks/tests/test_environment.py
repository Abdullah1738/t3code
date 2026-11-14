"""Set log destinations before importing hooks or starting child processes."""
import os
from pathlib import Path
import tempfile


# Override inherited production destinations. Children inherit these absolute
# paths even when a test changes HOME or starts Python in isolated mode.
LOG_TEMP = tempfile.TemporaryDirectory(prefix='harness-hooks-test-logs-')
LOG_ROOT = Path(LOG_TEMP.name)
os.environ['TOOLLOG_ROOT'] = str(LOG_ROOT)
os.environ['OFFBOX_TOOL_LOG_DIR'] = str(LOG_ROOT / 'offbox')

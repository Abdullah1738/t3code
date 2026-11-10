"""Fixture-only direct-tool latency smoke test, no production files or network."""
import json
import statistics
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_recall import build_fixture
import recall_core as rc
import recall_cli as cli

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    build_fixture(root)
    previous = rc._local
    rc._local = threading.local()
    try:
        with patch.object(rc, "MEM_DB", root / "memory.db"), patch.object(rc, "HOT_DB", None), \
             patch.object(rc, "CATALOG_DB", root / "catalog.db"), patch.object(rc, "OPENCODE_DB", root / "opencode.db"), \
             patch.object(rc, "STATE_DB", root / "statev2.sqlite"):
            rc.refresh_catalog(full=True)
            metrics = {}
            for name, call in (("search", lambda: rc.search("negative balance")),
                               ("list", lambda: rc.list_sessions(limit=20)),
                               ("read", lambda: cli.format_view("019e-kafka#1-5"))):
                values = []
                for _ in range(50):
                    started = time.monotonic()
                    call()
                    values.append((time.monotonic() - started) * 1000)
                metrics[name] = {"p50_ms": statistics.median(values), "p95_ms": sorted(values)[47], "n": len(values)}
            print(json.dumps(metrics, indent=2))
    finally:
        rc.close_readers()
        writer = getattr(rc._local, "catalog_w", None)
        if writer: writer.close()
        rc._local = previous

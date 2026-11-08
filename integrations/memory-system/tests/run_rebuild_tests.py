"""Linux fixtures use a recent SQLite without changing any host interpreter."""
import sys
import unittest
from pathlib import Path

import sqlite3 as stdlib_sqlite
try:
    import pysqlite3
except ImportError:
    pass
else:
    if stdlib_sqlite.sqlite_version_info < (3, 47):
        sys.modules["sqlite3"] = pysqlite3

sys.path.insert(0, str(Path(__file__).resolve().parent))
suite = unittest.defaultTestLoader.discover(str(Path(__file__).resolve().parent), pattern="test_*.py")
# The exporter needs incremental blob I/O (stdlib sqlite3), whereas old Ubuntu
# SQLite cannot create the newer FTS index. Keep each fixture on the real API it
# exercises rather than pretending pysqlite3 implements blobopen. The WAL
# truncate fixture needs Connection.setconfig(NO_CKPT_ON_CLOSE), which pysqlite3
# lacks, so its writer would checkpoint on close and leave no WAL to truncate.
for name in ("test_export_opencode", "test_native_export_consumers", "export_opencode",
             "test_wal_truncate", "wal_truncate"):
    if name in sys.modules:
        sys.modules[name].sqlite3 = stdlib_sqlite
raise SystemExit(not unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful())

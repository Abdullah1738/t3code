"""Local search diagnostics; never record query text or message contents."""
import contextlib
import json
import os
import resource
import sys
import time

import common


class SearchTiming:
    def __init__(self):
        self.started = time.perf_counter()
        self.usage = resource.getrusage(resource.RUSAGE_SELF)
        self.stages = {name: 0.0 for name in (
            "connect", "candidate_range", "fts_query", "fetch_filter", "dedupe", "chat_counts", "format", "close")}
        self.rows_matched = 0
        self.rows_returned = 0

    @contextlib.contextmanager
    def stage(self, name):
        start = time.perf_counter()
        try:
            yield
        finally:
            self.stages[name] += (time.perf_counter() - start) * 1000

    def emit(self, outcome):
        usage = resource.getrusage(resource.RUSAGE_SELF)
        record = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "pid": os.getpid(),
            "outcome": outcome, "stages_ms": {k: round(v, 3) for k, v in self.stages.items()},
            "total_ms": round((time.perf_counter() - self.started) * 1000, 3),
            # Matched means rows consumed from SQLite's limited result, before dedupe.
            "rows_matched": self.rows_matched, "rows_returned": self.rows_returned,
            "inblock_before": self.usage.ru_inblock, "inblock_after": usage.ru_inblock,
            "inblock": usage.ru_inblock - self.usage.ru_inblock,
            "cpu_ms": round(1000 * (usage.ru_utime + usage.ru_stime
                                    - self.usage.ru_utime - self.usage.ru_stime), 3),
        }
        line = json.dumps(record, separators=(",", ":")) + "\n"
        if os.environ.get("MSGS_TIMING") == "1":
            try:
                sys.stderr.write("msgs timing: " + line)
            except OSError:
                pass
        log_dir = os.environ.get("MSGS_LOG_DIR", os.path.join(common.HOME, ".local/share/message-archive/logs"))
        try:
            os.makedirs(log_dir, mode=0o700, exist_ok=True)
            # One append/write keeps concurrent short-lived CLI processes from interleaving lines.
            fd = os.open(os.path.join(log_dir, "search-timing.ndjson"),
                         os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                os.write(fd, line.encode())
            finally:
                os.close(fd)
        except OSError:
            pass  # A full/unavailable log disk must not break search output.

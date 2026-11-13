#!/usr/bin/env python3
"""Explicit bounded corpus indexing; request-time checks never walk these files."""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from recall_rules import RuleIndex


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path(os.environ.get("RECALL_RULES_DB", str(Path.home() / ".local/share/memory-system/data/recall_rules.db"))))
    parser.add_argument("--skills", type=Path, action="append", default=[])
    parser.add_argument("--agents", type=Path, action="append", default=[])
    parser.add_argument("--transcripts", type=Path)
    parser.add_argument("--repo-agents", action="store_true", help="import AGENTS.md at project dirs recorded by transcript capture")
    parser.add_argument("--max-rows", type=int, default=2000)
    parser.add_argument("--seconds", type=float, default=2)
    args = parser.parse_args()
    files = [path.expanduser() for path in args.agents]
    for root in args.skills:
        files.extend(root.expanduser().rglob("SKILL.md"))
    index = RuleIndex(args.db.expanduser())
    result = {"files": index.import_files(files)}
    if args.transcripts:
        result["transcripts"] = index.import_transcripts(args.transcripts.expanduser(), max_rows=args.max_rows, seconds=args.seconds)
    if args.repo_agents:
        import sqlite3
        from contextlib import closing
        with closing(sqlite3.connect(args.db.expanduser().as_uri() + "?mode=ro", uri=True)) as con:
            paths = [Path(row[0]) / "AGENTS.md" for row in con.execute("SELECT DISTINCT path FROM rule_aliases WHERE path LIKE '/%' LIMIT 5000").fetchall()]
        result["repo_agents"] = index.import_files([path for path in paths if path.is_file()])
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""One bounded resumable hot-index batch; safe to repeat until caught_up."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from recall_storage import build_index

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source", type=Path, required=True)
parser.add_argument("--index", type=Path, required=True)
parser.add_argument("--max-rows", type=int, default=5000)
parser.add_argument("--seconds", type=float, default=2)
args = parser.parse_args()
print(json.dumps(build_index(args.source, args.index, args.max_rows, args.seconds), indent=2))

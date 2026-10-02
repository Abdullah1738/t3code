#!/usr/bin/env python3
import json
from pathlib import Path
from datetime import datetime

def parse_timestamp(ts):
    if isinstance(ts, int):
        return ts
    if isinstance(ts, str):
        try:
            dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
            return int(dt.timestamp())
        except:
            return 0
    return 0

archived_dir = Path.home() / ".codex" / "archived_sessions"
test_file = list(archived_dir.glob("*.jsonl"))[0]

print(f"Testing: {test_file.name}")
print()

with open(test_file, 'r') as f:
    for i, line in enumerate(f, 1):
        if i > 5:
            break
        event = json.loads(line)
        ts = parse_timestamp(event.get('timestamp'))
        print(f"Line {i}: type={event.get('type')}, timestamp={ts}")

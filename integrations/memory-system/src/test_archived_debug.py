#!/usr/bin/env python3
import sqlite3
from pathlib import Path
import sys

print("Step 1: Finding archived directory...")
sys.stdout.flush()

archived_dir = Path.home() / ".codex" / "archived_sessions"
print(f"Directory: {archived_dir}")
print(f"Exists: {archived_dir.exists()}")
sys.stdout.flush()

print("\nStep 2: Listing files...")
sys.stdout.flush()

jsonl_files = list(archived_dir.glob("*.jsonl"))
print(f"Found {len(jsonl_files)} files")
sys.stdout.flush()

print("\nStep 3: Extracting session IDs...")
sys.stdout.flush()

session_to_file = {}
for i, jsonl_file in enumerate(jsonl_files):
    if i % 1000 == 0:
        print(f"  {i}/{len(jsonl_files)}...")
        sys.stdout.flush()
    parts = jsonl_file.stem.split('-')
    if len(parts) >= 8:
        session_id = '-'.join(parts[4:])
        session_to_file[session_id] = jsonl_file

print(f"Valid sessions: {len(session_to_file)}")
sys.stdout.flush()

print("\nStep 4: Connecting to DB...")
sys.stdout.flush()

db_path = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
conn = sqlite3.connect(str(db_path))
cursor = conn.cursor()
print("Connected")
sys.stdout.flush()

print("\nStep 5: Querying existing sessions...")
sys.stdout.flush()

cursor.execute("SELECT DISTINCT session_id FROM episodic_events WHERE source='codex'")
print("Query executed, fetching...")
sys.stdout.flush()

rows = cursor.fetchall()
print(f"Fetched {len(rows)} existing sessions")
sys.stdout.flush()

existing_sessions_set = set(row[0] for row in rows)
print(f"Set created with {len(existing_sessions_set)} sessions")
sys.stdout.flush()

print("\nStep 6: Computing new sessions...")
sys.stdout.flush()

new_sessions = {sid: f for sid, f in session_to_file.items() if sid not in existing_sessions_set}
print(f"New sessions: {len(new_sessions)}")
sys.stdout.flush()

conn.close()
print("\nDone!")

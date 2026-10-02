#!/usr/bin/env python3
"""
Import archived Codex sessions - with verbose debug output
"""

import sqlite3
import json
from pathlib import Path
from datetime import datetime
import sys

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

def map_content_type(codex_type):
    mapping = {
        'session_meta': 'text',
        'event_msg': 'text',
        'response_item': 'text',
        'turn_context': 'text',
        'world_state': 'text',
        'tool_call': 'tool_call',
        'tool_result': 'tool_result'
    }
    return mapping.get(codex_type, 'text')

def import_archived_sessions():
    print("=" * 70)
    print("IMPORTING ARCHIVED CODEX SESSIONS")
    print("=" * 70)
    sys.stdout.flush()
    
    archived_dir = Path.home() / ".codex" / "archived_sessions"
    db_path = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    
    jsonl_files = list(archived_dir.glob("*.jsonl"))
    print(f"\nFound {len(jsonl_files):,} archived session files")
    sys.stdout.flush()
    
    # Extract all session IDs
    print("Extracting session IDs...")
    sys.stdout.flush()
    session_to_file = {}
    for jsonl_file in jsonl_files:
        parts = jsonl_file.stem.split('-')
        if len(parts) >= 8:
            session_id = '-'.join(parts[4:])
            session_to_file[session_id] = jsonl_file
    
    print(f"Valid sessions: {len(session_to_file):,}")
    sys.stdout.flush()
    
    # Batch-check existing
    print("Checking existing sessions...")
    sys.stdout.flush()
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    
    cursor.execute("SELECT DISTINCT session_id FROM episodic_events WHERE source='codex'")
    existing_sessions_set = set(row[0] for row in cursor.fetchall())
    
    print(f"Already in DB: {len(existing_sessions_set):,}")
    sys.stdout.flush()
    
    new_sessions = {sid: f for sid, f in session_to_file.items() if sid not in existing_sessions_set}
    print(f"To import: {len(new_sessions):,}\n")
    sys.stdout.flush()
    
    if not new_sessions:
        print("No new sessions to import.")
        conn.close()
        return
    
    imported_sessions = 0
    imported_events = 0
    errors = 0
    
    print("Starting import...")
    sys.stdout.flush()
    
    for i, (session_id, jsonl_file) in enumerate(new_sessions.items(), 1):
        if i == 1 or i % 100 == 0:
            print(f"  {i:,} / {len(new_sessions):,} sessions... (events: {imported_events:,})")
            sys.stdout.flush()
            conn.commit()
        
        try:
            with open(jsonl_file, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            
            session_events = 0
            for line_num, line in enumerate(lines, 1):
                line = line.strip()
                if not line:
                    continue
                
                try:
                    event = json.loads(line)
                    
                    timestamp = parse_timestamp(event.get('timestamp', 0))
                    codex_type = event.get('type', 'text')
                    content_type = map_content_type(codex_type)
                    
                    speaker = 'system'
                    content = ''
                    
                    if codex_type == 'session_meta':
                        speaker = 'system'
                        content = json.dumps(event.get('payload', {}))
                    elif codex_type == 'event_msg':
                        payload = event.get('payload', {})
                        speaker = payload.get('role', 'user')
                        if speaker == 'model':
                            speaker = 'assistant'
                        content = payload.get('content', '')
                    elif codex_type == 'response_item':
                        speaker = 'assistant'
                        payload = event.get('payload', {})
                        content = payload.get('text', '') or json.dumps(payload)
                    elif codex_type in ('turn_context', 'world_state'):
                        speaker = 'system'
                        content = json.dumps(event.get('payload', {}))
                    else:
                        content = json.dumps(event)
                    
                    metadata = {
                        'file': jsonl_file.name,
                        'codex_type': codex_type
                    }
                    
                    cursor.execute("""
                        INSERT INTO episodic_events 
                        (source, session_id, turn_id, timestamp, speaker, content, content_type, metadata_json)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        'codex',
                        session_id,
                        line_num,
                        timestamp,
                        speaker,
                        content,
                        content_type,
                        json.dumps(metadata)
                    ))
                    
                    session_events += 1
                    
                except json.JSONDecodeError:
                    continue
                except Exception as e:
                    errors += 1
                    if i <= 10:  # Log first few errors
                        print(f"    Error in session {i}: {e}")
                        sys.stdout.flush()
            
            if session_events > 0:
                imported_sessions += 1
                imported_events += session_events
            
        except Exception as e:
            errors += 1
            if i <= 10:
                print(f"    Error processing session {i}: {e}")
                sys.stdout.flush()
    
    conn.commit()
    conn.close()
    
    print()
    print("=" * 70)
    print("IMPORT COMPLETE")
    print("=" * 70)
    print(f"Imported: {imported_sessions:,} sessions, {imported_events:,} events")
    print(f"Errors:   {errors:,}")
    sys.stdout.flush()

if __name__ == '__main__':
    import_archived_sessions()

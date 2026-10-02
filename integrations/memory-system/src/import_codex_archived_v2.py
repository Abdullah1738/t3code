#!/usr/bin/env python3
"""
Import archived Codex sessions from ~/.codex/archived_sessions/
Handle all content types: session_meta, event_msg, response_item, turn_context, world_state
"""

import sqlite3
import json
from pathlib import Path
from datetime import datetime

def parse_timestamp(ts):
    """Convert ISO timestamp to Unix integer"""
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
    """Map Codex types to our schema"""
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
    print()
    
    archived_dir = Path.home() / ".codex" / "archived_sessions"
    db_path = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    
    if not archived_dir.exists():
        print(f"✗ Archived directory not found: {archived_dir}")
        return
    
    jsonl_files = list(archived_dir.glob("*.jsonl"))
    print(f"Found {len(jsonl_files):,} archived session files")
    print()
    
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    
    cursor.execute("SELECT COUNT(DISTINCT session_id) FROM episodic_events WHERE source='codex'")
    existing_sessions = cursor.fetchone()[0]
    print(f"Existing Codex sessions in DB: {existing_sessions:,}")
    print()
    
    imported_sessions = 0
    imported_events = 0
    skipped_sessions = 0
    errors = 0
    
    print("Processing files...")
    for i, jsonl_file in enumerate(jsonl_files, 1):
        if i % 500 == 0:
            print(f"  {i:,} / {len(jsonl_files):,} files...")
            conn.commit()
        
        # Extract session_id from filename
        parts = jsonl_file.stem.split('-')
        if len(parts) < 8:
            errors += 1
            continue
        
        session_id = '-'.join(parts[4:])
        
        # Check if already exists
        cursor.execute("SELECT COUNT(*) FROM episodic_events WHERE source='codex' AND session_id=?", (session_id,))
        if cursor.fetchone()[0] > 0:
            skipped_sessions += 1
            continue
        
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
                    
                    # Extract fields
                    timestamp = parse_timestamp(event.get('timestamp', 0))
                    codex_type = event.get('type', 'text')
                    content_type = map_content_type(codex_type)
                    
                    # Determine speaker and content based on type
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
                    elif codex_type == 'turn_context':
                        speaker = 'system'
                        content = json.dumps(event.get('payload', {}))
                    elif codex_type == 'world_state':
                        speaker = 'system'
                        content = json.dumps(event.get('payload', {}))
                    else:
                        content = json.dumps(event)
                    
                    # Build metadata
                    metadata = {
                        'file': jsonl_file.name,
                        'codex_type': codex_type
                    }
                    
                    # Insert event
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
                    if errors < 10:
                        print(f"  Event error in {jsonl_file.name}:{line_num}: {e}")
                    errors += 1
            
            if session_events > 0:
                imported_sessions += 1
                imported_events += session_events
            
        except Exception as e:
            if errors < 10:
                print(f"  File error {jsonl_file.name}: {e}")
            errors += 1
    
    conn.commit()
    conn.close()
    
    print()
    print("=" * 70)
    print("IMPORT COMPLETE")
    print("=" * 70)
    print(f"Imported:        {imported_sessions:,} sessions, {imported_events:,} events")
    print(f"Skipped:         {skipped_sessions:,} sessions (already in DB)")
    print(f"Errors:          {errors:,}")
    print()
    
    # Final counts
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(DISTINCT session_id) FROM episodic_events WHERE source='codex'")
    total_codex_sessions = cursor.fetchone()[0]
    cursor.execute("SELECT COUNT(*) FROM episodic_events WHERE source='codex'")
    total_codex_events = cursor.fetchone()[0]
    conn.close()
    
    print(f"Total Codex sessions now: {total_codex_sessions:,}")
    print(f"Total Codex events now:   {total_codex_events:,}")

if __name__ == '__main__':
    import_archived_sessions()

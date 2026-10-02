#!/usr/bin/env python3
"""
Import archived Codex sessions from ~/.codex/archived_sessions/
"""

import sqlite3
import json
from pathlib import Path
from datetime import datetime

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
    
    # Get all .jsonl files
    jsonl_files = list(archived_dir.glob("*.jsonl"))
    print(f"Found {len(jsonl_files):,} archived session files")
    print()
    
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    
    # Count existing Codex sessions
    cursor.execute("SELECT COUNT(DISTINCT session_id) FROM episodic_events WHERE source='codex'")
    existing_sessions = cursor.fetchone()[0]
    print(f"Existing Codex sessions in DB: {existing_sessions:,}")
    print()
    
    imported_sessions = 0
    imported_events = 0
    skipped_sessions = 0
    errors = 0
    
    for i, jsonl_file in enumerate(jsonl_files, 1):
        if i % 500 == 0:
            print(f"  Processing {i:,} / {len(jsonl_files):,} files...")
            conn.commit()
        
        # Extract session_id from filename: rollout-DATE-SESSION_ID.jsonl
        parts = jsonl_file.stem.split('-')
        if len(parts) < 8:
            errors += 1
            continue
        
        session_id = '-'.join(parts[4:])  # Everything after the date
        
        # Check if session already exists
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
                    timestamp = event.get('timestamp', 0)
                    speaker = event.get('speaker', 'system')
                    content = event.get('content', '')
                    content_type = event.get('type', 'text')
                    
                    # Build metadata
                    metadata = {
                        'file': jsonl_file.name,
                        'event_type': event.get('event_type', 'message')
                    }
                    if 'model' in event:
                        metadata['model'] = event['model']
                    
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
            
            if session_events > 0:
                imported_sessions += 1
                imported_events += session_events
            
        except Exception as e:
            errors += 1
            if errors <= 5:
                print(f"  Error processing {jsonl_file.name}: {e}")
    
    conn.commit()
    conn.close()
    
    print()
    print("=" * 70)
    print("IMPORT COMPLETE")
    print("=" * 70)
    print(f"Imported:        {imported_sessions:,} sessions, {imported_events:,} events")
    print(f"Skipped:         {skipped_sessions:,} sessions (already in DB)")
    print(f"Errors:          {errors:,} files")
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

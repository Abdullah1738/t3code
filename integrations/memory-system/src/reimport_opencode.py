#!/usr/bin/env python3
"""
Reimport OpenCode with proper message+part join to recover missing content
"""

import sqlite3
import json
import time
from pathlib import Path
from collections import defaultdict

def reimport_opencode():
    """Reimport OpenCode messages by joining message + part tables"""
    print("=" * 80)
    print("Reimporting OpenCode messages (with part content)")
    print("=" * 80)
    
    source_db = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
    target_db = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    
    if not source_db.exists():
        print(f"✗ Source database not found: {source_db}")
        return
    
    source_conn = sqlite3.connect(str(source_db))
    target_conn = sqlite3.connect(str(target_db))
    
    cursor = target_conn.cursor()
    
    # Delete all existing OpenCode events (they have empty content)
    print("\nDeleting old OpenCode events with empty content...")
    cursor.execute("DELETE FROM episodic_events WHERE source = 'opencode'")
    deleted = cursor.rowcount
    target_conn.commit()
    print(f"✓ Deleted {deleted:,} old OpenCode events")
    
    # Remove old import status
    cursor.execute("DELETE FROM import_status WHERE source = 'opencode'")
    target_conn.commit()
    
    # Start new import tracking
    cursor.execute("""
        INSERT INTO import_status (source, import_started_at, status)
        VALUES ('opencode', ?, 'in_progress')
    """, (int(time.time()),))
    import_id = cursor.lastrowid
    target_conn.commit()
    
    # Optimize for bulk insert
    target_conn.execute("PRAGMA journal_mode = WAL")
    target_conn.execute("PRAGMA synchronous = NORMAL")
    target_conn.execute("PRAGMA cache_size = -64000")
    target_conn.execute("PRAGMA temp_store = MEMORY")
    
    print("\nFetching messages and their parts...")
    start_time = time.time()
    
    try:
        # Get all messages
        source_cursor = source_conn.cursor()
        source_cursor.execute("""
            SELECT id, session_id, time_created, data
            FROM message
            ORDER BY time_created
        """)
        
        messages = source_cursor.fetchall()
        print(f"Found {len(messages):,} messages")
        
        # Get all parts grouped by message_id
        print("Loading parts...")
        source_cursor.execute("""
            SELECT message_id, data
            FROM part
            ORDER BY message_id, time_created
        """)
        
        parts_by_message = defaultdict(list)
        for message_id, part_data_str in source_cursor:
            try:
                part_data = json.loads(part_data_str)
                parts_by_message[message_id].append(part_data)
            except json.JSONDecodeError:
                continue
        
        print(f"Loaded {sum(len(p) for p in parts_by_message.values()):,} parts for {len(parts_by_message):,} messages")
        
        # Process messages with their parts
        print("\nProcessing messages with parts...")
        batch = []
        batch_size = 10000
        total_imported = 0
        skipped_no_parts = 0
        
        for idx, (msg_id, session_id, time_created, msg_data_str) in enumerate(messages):
            try:
                msg_data = json.loads(msg_data_str)
                parts = parts_by_message.get(msg_id, [])
                
                if not parts:
                    skipped_no_parts += 1
                    continue
                
                role = msg_data.get('role', 'user')
                
                # Reconstruct content from parts
                text_parts = []
                tool_calls = []
                tool_results = []
                
                for part in parts:
                    part_type = part.get('type')
                    
                    if part_type == 'text':
                        text_parts.append(part.get('text', ''))
                    elif part_type == 'tool':
                        tool_calls.append(part)
                    elif part_type == 'reasoning':
                        # Include reasoning as part of content
                        reasoning_text = part.get('text', '')
                        if reasoning_text:
                            text_parts.append(f"[Reasoning: {reasoning_text}]")
                    # step-start, step-finish, compaction, patch, file types are metadata
                
                # Determine content and content_type
                content = ''
                content_type = 'text'
                
                if tool_calls:
                    content_type = 'tool_call'
                    content = json.dumps(tool_calls)
                elif text_parts:
                    content = '\n'.join(text_parts)
                    content_type = 'text'
                
                # Extract model info
                model = None
                if isinstance(msg_data.get('model'), dict):
                    model = msg_data['model'].get('modelID')
                
                # Extract token count
                tokens = None
                if isinstance(msg_data.get('tokens'), dict):
                    tokens = msg_data['tokens'].get('total')
                
                metadata = {
                    'agent': msg_data.get('agent'),
                    'mode': msg_data.get('mode'),
                    'num_parts': len(parts),
                    'part_types': list(set(p.get('type') for p in parts))
                }
                
                batch.append((
                    'opencode',
                    session_id,
                    msg_id,
                    time_created // 1000,  # ms to seconds
                    role,
                    content,
                    content_type,
                    model,
                    tokens,
                    json.dumps(metadata)
                ))
                
                # Insert batch
                if len(batch) >= batch_size:
                    cursor.executemany("""
                        INSERT OR IGNORE INTO episodic_events
                        (source, session_id, turn_id, timestamp, speaker, content,
                         content_type, model, tokens_used, metadata_json)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, batch)
                    target_conn.commit()
                    
                    total_imported += len(batch)
                    batch = []
                    
                    elapsed = time.time() - start_time
                    rate = total_imported / elapsed if elapsed > 0 else 0
                    remaining = len(messages) - idx
                    eta_seconds = remaining / rate if rate > 0 else 0
                    eta_minutes = eta_seconds / 60
                    
                    print(f"  {total_imported:,}/{len(messages):,} messages ({rate:.0f}/sec, ETA: {eta_minutes:.1f}m)  ", end='\r')
            
            except (json.JSONDecodeError, KeyError) as e:
                continue
        
        # Insert remaining batch
        if batch:
            cursor.executemany("""
                INSERT OR IGNORE INTO episodic_events
                (source, session_id, turn_id, timestamp, speaker, content,
                 content_type, model, tokens_used, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, batch)
            target_conn.commit()
            total_imported += len(batch)
        
        print(f"\n\n✓ Imported {total_imported:,} OpenCode events")
        print(f"  Skipped {skipped_no_parts:,} messages with no parts")
        
        # Verify content is not empty
        cursor.execute("""
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN LENGTH(content) = 0 THEN 1 END) as empty,
                COUNT(CASE WHEN LENGTH(content) > 0 THEN 1 END) as with_content,
                AVG(LENGTH(content)) as avg_length
            FROM episodic_events
            WHERE source = 'opencode'
        """)
        total, empty, with_content, avg_length = cursor.fetchone()
        
        print(f"\nContent verification:")
        print(f"  Total events: {total:,}")
        print(f"  With content: {with_content:,} ({100*with_content/total:.1f}%)")
        print(f"  Empty content: {empty:,} ({100*empty/total:.1f}%)")
        print(f"  Avg content length: {avg_length:.0f} chars")
        
        # Mark complete
        cursor.execute("""
            UPDATE import_status
            SET import_completed_at = ?,
                total_events = ?,
                status = 'completed'
            WHERE id = ?
        """, (int(time.time()), total_imported, import_id))
        target_conn.commit()
        
    except Exception as e:
        print(f"\n✗ Error: {e}")
        cursor.execute("""
            UPDATE import_status
            SET status = 'failed',
                error_message = ?
            WHERE id = ?
        """, (str(e), import_id))
        target_conn.commit()
        raise
    finally:
        source_conn.close()
        target_conn.close()


if __name__ == "__main__":
    reimport_opencode()

#!/usr/bin/env python3
"""
Reimport OpenCode with streaming message+part join (memory efficient)
"""

import sqlite3
import json
import time
from pathlib import Path

def reimport_opencode_streaming():
    """Reimport OpenCode messages by streaming message+part join"""
    print("=" * 80)
    print("Reimporting OpenCode messages (streaming mode)")
    print("=" * 80)
    
    source_db = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
    target_db = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    
    if not source_db.exists():
        print(f"✗ Source database not found: {source_db}")
        return
    
    source_conn = sqlite3.connect(str(source_db))
    target_conn = sqlite3.connect(str(target_db))
    
    cursor = target_conn.cursor()
    
    # Check if OpenCode already has events
    cursor.execute("SELECT COUNT(*) FROM episodic_events WHERE source = 'opencode'")
    existing = cursor.fetchone()[0]
    
    if existing == 0:
        print(f"Current OpenCode events: {existing:,} (empty, will import)")
    else:
        print(f"Current OpenCode events: {existing:,}")
        response = input("Delete and reimport? (yes/no): ")
        if response.lower() != 'yes':
            print("Aborted.")
            return
        
        print("\nDeleting old OpenCode events...")
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
    target_conn.execute("PRAGMA cache_size = -128000")  # 128MB cache
    target_conn.execute("PRAGMA temp_store = MEMORY")
    
    print("\nStreaming messages with their parts...")
    start_time = time.time()
    
    try:
        # Count total messages
        source_cursor = source_conn.cursor()
        source_cursor.execute("SELECT COUNT(*) FROM message")
        total_messages = source_cursor.fetchone()[0]
        print(f"Total messages to process: {total_messages:,}")
        
        # Stream messages in batches
        batch_size = 5000
        offset = 0
        total_imported = 0
        skipped_no_parts = 0
        skipped_empty_content = 0
        
        insert_batch = []
        insert_batch_size = 1000
        
        while True:
            # Fetch batch of messages
            source_cursor.execute("""
                SELECT id, session_id, time_created, data
                FROM message
                ORDER BY time_created
                LIMIT ? OFFSET ?
            """, (batch_size, offset))
            
            messages = source_cursor.fetchall()
            if not messages:
                break
            
            # For each message, fetch its parts
            for msg_id, session_id, time_created, msg_data_str in messages:
                try:
                    msg_data = json.loads(msg_data_str)
                    
                    # Fetch parts for this message
                    parts_cursor = source_conn.cursor()
                    parts_cursor.execute("""
                        SELECT data
                        FROM part
                        WHERE message_id = ?
                        ORDER BY time_created
                    """, (msg_id,))
                    
                    parts = []
                    for (part_data_str,) in parts_cursor:
                        try:
                            parts.append(json.loads(part_data_str))
                        except json.JSONDecodeError:
                            continue
                    
                    if not parts:
                        skipped_no_parts += 1
                        continue
                    
                    role = msg_data.get('role', 'user')
                    
                    # Reconstruct content from parts
                    text_parts = []
                    tool_calls = []
                    
                    for part in parts:
                        part_type = part.get('type')
                        
                        if part_type == 'text':
                            text_parts.append(part.get('text', ''))
                        elif part_type == 'tool':
                            tool_calls.append(part)
                        elif part_type == 'reasoning':
                            reasoning_text = part.get('text', '')
                            if reasoning_text:
                                text_parts.append(f"[Reasoning: {reasoning_text}]")
                    
                    # Determine content and content_type
                    content = ''
                    content_type = 'text'
                    
                    if tool_calls:
                        content_type = 'tool_call'
                        content = json.dumps(tool_calls)
                    elif text_parts:
                        content = '\n'.join(text_parts)
                        content_type = 'text'
                    
                    # Skip if no actual content
                    if not content or len(content) == 0:
                        skipped_empty_content += 1
                        continue
                    
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
                        'num_parts': len(parts)
                    }
                    
                    insert_batch.append((
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
                    
                    # Insert when batch is full
                    if len(insert_batch) >= insert_batch_size:
                        cursor.executemany("""
                            INSERT OR IGNORE INTO episodic_events
                            (source, session_id, turn_id, timestamp, speaker, content,
                             content_type, model, tokens_used, metadata_json)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """, insert_batch)
                        target_conn.commit()
                        
                        total_imported += len(insert_batch)
                        insert_batch = []
                
                except (json.JSONDecodeError, KeyError) as e:
                    continue
            
            offset += batch_size
            
            elapsed = time.time() - start_time
            rate = total_imported / elapsed if elapsed > 0 else 0
            progress_pct = 100 * offset / total_messages
            remaining = total_messages - offset
            eta_seconds = remaining / (offset / elapsed) if offset > 0 and elapsed > 0 else 0
            eta_minutes = eta_seconds / 60
            
            print(f"  Progress: {offset:,}/{total_messages:,} ({progress_pct:.1f}%) | Imported: {total_imported:,} | Rate: {rate:.0f}/sec | ETA: {eta_minutes:.1f}m  ", end='\r')
        
        # Insert remaining batch
        if insert_batch:
            cursor.executemany("""
                INSERT OR IGNORE INTO episodic_events
                (source, session_id, turn_id, timestamp, speaker, content,
                 content_type, model, tokens_used, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, insert_batch)
            target_conn.commit()
            total_imported += len(insert_batch)
        
        print(f"\n\n✓ Imported {total_imported:,} OpenCode events")
        print(f"  Skipped {skipped_no_parts:,} messages with no parts")
        print(f"  Skipped {skipped_empty_content:,} messages with empty content")
        
        # Verify content is not empty
        cursor.execute("""
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN LENGTH(content) = 0 THEN 1 END) as empty,
                COUNT(CASE WHEN LENGTH(content) > 0 THEN 1 END) as with_content,
                AVG(LENGTH(content)) as avg_length,
                COUNT(DISTINCT session_id) as sessions
            FROM episodic_events
            WHERE source = 'opencode'
        """)
        total, empty, with_content, avg_length, sessions = cursor.fetchone()
        
        print(f"\nContent verification:")
        print(f"  Total events: {total:,}")
        print(f"  Sessions: {sessions:,}")
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
        
        # Checkpoint WAL
        print("\nCheckpointing WAL...")
        target_conn.execute("PRAGMA wal_checkpoint(RESTART)")
        print("✓ WAL checkpoint complete")
        
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
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
    reimport_opencode_streaming()

#!/usr/bin/env python3
"""
Resumable OpenCode import with checkpoint recovery
"""

import sqlite3
import json
import time
from pathlib import Path
from collections import defaultdict

CHECKPOINT_FILE = Path.home() / ".local/share/memory-system/opencode_import_checkpoint.txt"

def get_last_checkpoint():
    """Get last successfully processed message offset"""
    if CHECKPOINT_FILE.exists():
        return int(CHECKPOINT_FILE.read_text().strip())
    return 0

def save_checkpoint(offset):
    """Save current offset"""
    CHECKPOINT_FILE.write_text(str(offset))

def reimport_opencode_resumable():
    """Resumable OpenCode import"""
    print("=" * 80)
    print("Resumable OpenCode Import")
    print("=" * 80)
    
    source_db = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
    target_db = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    
    source_conn = sqlite3.connect(str(source_db))
    target_conn = sqlite3.connect(str(target_db))
    
    cursor = target_conn.cursor()
    
    # Check current state
    cursor.execute("SELECT COUNT(*), COUNT(DISTINCT session_id) FROM episodic_events WHERE source = 'opencode'")
    existing_events, existing_sessions = cursor.fetchone()
    
    source_cursor = source_conn.cursor()
    source_cursor.execute("SELECT COUNT(*) FROM message")
    total_messages = source_cursor.fetchone()[0]
    
    source_cursor.execute("SELECT COUNT(DISTINCT session_id) FROM message")
    total_sessions = source_cursor.fetchone()[0]
    
    print(f"Target DB: {existing_events:,} events from {existing_sessions:,} sessions")
    print(f"Source DB: {total_messages:,} messages from {total_sessions:,} sessions")
    
    # Check checkpoint
    last_offset = get_last_checkpoint()
    if last_offset > 0:
        print(f"Resuming from checkpoint: offset {last_offset:,} (auto-resume; delete checkpoint file to start fresh)")
    else:
        print("No checkpoint found, starting fresh")
    
    # Optimize for bulk insert
    target_conn.execute("PRAGMA journal_mode = WAL")
    target_conn.execute("PRAGMA synchronous = NORMAL")
    target_conn.execute("PRAGMA cache_size = -256000")
    target_conn.execute("PRAGMA temp_store = MEMORY")
    
    print("\nImporting messages...")
    start_time = time.time()
    
    try:
        message_batch_size = 10000
        offset = last_offset
        total_imported = 0
        skipped_no_parts = 0
        skipped_empty_content = 0
        
        insert_batch = []
        insert_batch_size = 2000
        
        while offset < total_messages:
            batch_start = time.time()
            
            # Fetch batch of messages
            source_cursor.execute("""
                SELECT id, session_id, time_created, data
                FROM message
                ORDER BY time_created
                LIMIT ? OFFSET ?
            """, (message_batch_size, offset))
            
            messages = source_cursor.fetchall()
            if not messages:
                break
            
            message_ids = [msg[0] for msg in messages]
            
            # Fetch ALL parts for this batch
            parts_cursor = source_conn.cursor()
            placeholders = ','.join('?' * len(message_ids))
            parts_cursor.execute(f"""
                SELECT message_id, data
                FROM part
                WHERE message_id IN ({placeholders})
                ORDER BY message_id, time_created
            """, message_ids)
            
            # Group parts by message_id
            parts_by_message = defaultdict(list)
            for msg_id, part_data_str in parts_cursor:
                try:
                    parts_by_message[msg_id].append(json.loads(part_data_str))
                except json.JSONDecodeError:
                    continue
            
            # Process each message
            for msg_id, session_id, time_created, msg_data_str in messages:
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
                    
                    # Determine content
                    content = ''
                    content_type = 'text'
                    
                    if tool_calls:
                        content_type = 'tool_call'
                        content = json.dumps(tool_calls)
                    elif text_parts:
                        content = '\n'.join(text_parts)
                        content_type = 'text'
                    
                    if not content:
                        skipped_empty_content += 1
                        continue
                    
                    # Extract metadata
                    model = None
                    if isinstance(msg_data.get('model'), dict):
                        model = msg_data['model'].get('modelID')
                    
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
                        time_created // 1000,
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
                
                except (json.JSONDecodeError, KeyError):
                    continue
            
            # Update offset and save checkpoint
            offset += message_batch_size
            save_checkpoint(offset)
            
            batch_time = time.time() - batch_start
            elapsed = time.time() - start_time
            rate = total_imported / elapsed if elapsed > 0 else 0
            progress_pct = 100 * offset / total_messages
            remaining = total_messages - offset
            eta_seconds = remaining / (offset / elapsed) if offset > 0 and elapsed > 0 else 0
            eta_minutes = eta_seconds / 60
            
            print(f"  [{offset:,}/{total_messages:,}] {progress_pct:.1f}% | {total_imported:,} events | {rate:.0f}/sec | ETA: {eta_minutes:.1f}m | batch: {batch_time:.1f}s", flush=True)
        
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
        
        elapsed = time.time() - start_time
        print(f"\n✓ Import complete!")
        print(f"  Imported: {total_imported:,} events in {elapsed/60:.1f} minutes")
        print(f"  Skipped: {skipped_no_parts:,} (no parts) + {skipped_empty_content:,} (empty)")
        
        # Final verification
        cursor.execute("""
            SELECT 
                COUNT(*) as total,
                COUNT(DISTINCT session_id) as sessions,
                AVG(LENGTH(content)) as avg_length
            FROM episodic_events
            WHERE source = 'opencode'
        """)
        total, sessions, avg_length = cursor.fetchone()
        
        print(f"\nFinal stats:")
        print(f"  Total events: {total:,}")
        print(f"  Sessions: {sessions:,} / {total_sessions:,}")
        print(f"  Avg content length: {avg_length:.0f} chars")
        
        # Checkpoint WAL
        print("\nCheckpointing WAL...")
        target_conn.execute("PRAGMA wal_checkpoint(RESTART)")
        print("✓ Done")
        
        # Clean up checkpoint file
        if CHECKPOINT_FILE.exists():
            CHECKPOINT_FILE.unlink()
        
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
        print(f"\nCheckpoint saved at offset {offset:,}")
        print("Run again to resume from checkpoint")
        raise
    finally:
        source_conn.close()
        target_conn.close()


if __name__ == "__main__":
    reimport_opencode_resumable()

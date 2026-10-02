#!/usr/bin/env python3
"""
Fast streaming import - process messages in batches without loading everything into memory
"""

import sqlite3
import json
import time
import glob
from pathlib import Path

def import_hermes():
    """Import Hermes messages in streaming batches"""
    print("=" * 60)
    print("Importing Hermes messages...")
    print("=" * 60)
    
    source_db = Path.home() / ".hermes" / "state.db"
    target_db = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    
    source_conn = sqlite3.connect(str(source_db))
    target_conn = sqlite3.connect(str(target_db))
    
    # Check if already completed
    cursor = target_conn.cursor()
    cursor.execute("SELECT id, status FROM import_status WHERE source = 'hermes' AND status = 'completed'")
    if cursor.fetchone():
        print("✓ Hermes already imported, skipping...")
        target_conn.close()
        source_conn.close()
        return
    
    # Clean up stale in_progress records
    cursor.execute("DELETE FROM import_status WHERE source = 'hermes' AND status = 'in_progress'")
    target_conn.commit()
    
    # Start import tracking
    cursor.execute("""
        INSERT INTO import_status (source, import_started_at, status)
        VALUES ('hermes', ?, 'in_progress')
    """, (int(time.time()),))
    import_id = cursor.lastrowid
    target_conn.commit()
    
    # Optimize for bulk insert
    target_conn.execute("PRAGMA journal_mode = WAL")
    target_conn.execute("PRAGMA synchronous = NORMAL")
    target_conn.execute("PRAGMA cache_size = -64000")  # 64MB cache
    target_conn.execute("PRAGMA temp_store = MEMORY")
    
    # Stream in batches
    batch_size = 50000  # Larger batches
    offset = 0
    total_imported = 0
    start_time = time.time()
    
    try:
        while True:
            source_cursor = source_conn.cursor()
            source_cursor.execute("""
                SELECT 
                    m.id,
                    m.session_id,
                    m.role,
                    m.content,
                    m.tool_call_id,
                    m.tool_calls,
                    m.tool_name,
                    m.timestamp,
                    m.token_count,
                    s.model,
                    s.display_name
                FROM messages m
                LEFT JOIN sessions s ON m.session_id = s.id
                ORDER BY m.timestamp
                LIMIT ? OFFSET ?
            """, (batch_size, offset))
            
            rows = source_cursor.fetchall()
            if not rows:
                break
            
            # Prepare batch for insert
            batch = []
            for row in rows:
                content_type = 'text'
                content = row[3] or ''
                
                if row[5]:  # tool_calls
                    content_type = 'tool_call'
                    content = row[5]
                elif row[4]:  # tool_call_id
                    content_type = 'tool_result'
                
                metadata = {
                    'session_name': row[10],
                    'tool_name': row[6]
                }
                
                batch.append((
                    'hermes',
                    row[1],  # session_id
                    str(row[0]),  # turn_id
                    int(row[7]),  # timestamp
                    row[2],  # role (speaker)
                    content,
                    content_type,
                    row[9],  # model
                    row[8],  # token_count
                    json.dumps(metadata)
                ))
            
            # Insert batch (commit every 5 batches for speed)
            target_cursor = target_conn.cursor()
            target_cursor.executemany("""
                INSERT OR IGNORE INTO episodic_events
                (source, session_id, turn_id, timestamp, speaker, content, 
                 content_type, model, tokens_used, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, batch)
            
            if offset % (batch_size * 5) == 0:
                target_conn.commit()
            
            total_imported += len(rows)
            offset += batch_size
            
            elapsed = time.time() - start_time
            rate = total_imported / elapsed if elapsed > 0 else 0
            # Updated estimate: 3.5M Hermes messages (including archived)
            eta_seconds = (3500000 - total_imported) / rate if rate > 0 else 0
            eta_minutes = eta_seconds / 60
            
            print(f"  {total_imported:,} events imported ({rate:.0f}/sec, ETA: {eta_minutes:.0f}m)  ", end='\r')
        
        # Final commit
        target_conn.commit()
        
        print(f"\n✓ Imported {total_imported:,} Hermes events")
        
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


def import_opencode():
    """Import OpenCode messages in streaming batches"""
    print("\n" + "=" * 60)
    print("Importing OpenCode messages...")
    print("=" * 60)
    
    source_db = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
    target_db = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    
    source_conn = sqlite3.connect(str(source_db))
    target_conn = sqlite3.connect(str(target_db))
    
    # Check if already completed
    cursor = target_conn.cursor()
    cursor.execute("SELECT id, status FROM import_status WHERE source = 'opencode' AND status = 'completed'")
    if cursor.fetchone():
        print("✓ OpenCode already imported, skipping...")
        target_conn.close()
        source_conn.close()
        return
    
    # Clean up stale in_progress records
    cursor.execute("DELETE FROM import_status WHERE source = 'opencode' AND status = 'in_progress'")
    target_conn.commit()
    
    # Start import tracking
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
    
    # Stream in batches
    batch_size = 50000  # Larger batches
    offset = 0
    total_imported = 0
    skipped = 0
    start_time = time.time()
    
    try:
        while True:
            source_cursor = source_conn.cursor()
            source_cursor.execute("""
                SELECT id, session_id, time_created, data
                FROM message
                ORDER BY time_created
                LIMIT ? OFFSET ?
            """, (batch_size, offset))
            
            rows = source_cursor.fetchall()
            if not rows:
                break
            
            # Prepare batch for insert
            batch = []
            for row in rows:
                try:
                    data = json.loads(row[3])
                    
                    role = data.get('role', 'user')
                    
                    # Extract content
                    content = ''
                    content_type = 'text'
                    
                    if 'text' in data:
                        content = data['text']
                    elif 'content' in data:
                        content = data['content']
                    elif 'parts' in data:
                        content = json.dumps(data['parts'])
                    
                    if 'toolCalls' in data or 'tool_calls' in data:
                        content_type = 'tool_call'
                    
                    model = None
                    if isinstance(data.get('model'), dict):
                        model = data['model'].get('modelID')
                    
                    tokens = None
                    if isinstance(data.get('tokens'), dict):
                        tokens = data['tokens'].get('total')
                    
                    metadata = {
                        'agent': data.get('agent'),
                        'mode': data.get('mode')
                    }
                    
                    batch.append((
                        'opencode',
                        row[1],  # session_id
                        row[0],  # message id
                        row[2] // 1000,  # timestamp (ms to s)
                        role,
                        content,
                        content_type,
                        model,
                        tokens,
                        json.dumps(metadata)
                    ))
                    
                except (json.JSONDecodeError, KeyError):
                    skipped += 1
                    continue
            
            # Insert batch
            target_cursor = target_conn.cursor()
            target_cursor.executemany("""
                INSERT OR IGNORE INTO episodic_events
                (source, session_id, turn_id, timestamp, speaker, content, 
                 content_type, model, tokens_used, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, batch)
            
            target_conn.commit()
            total_imported += len(batch)
            offset += batch_size
            
            elapsed = time.time() - start_time
            rate = total_imported / elapsed if elapsed > 0 else 0
            # ~3.5M OpenCode messages
            eta_seconds = (3500000 - total_imported) / rate if rate > 0 else 0
            eta_minutes = eta_seconds / 60
            
            print(f"  {total_imported:,} events imported ({rate:.0f}/sec, ETA: {eta_minutes:.0f}m)  ", end='\r')
        
        print(f"\n✓ Imported {total_imported:,} OpenCode events (skipped {skipped} malformed)")
        
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


def import_codex():
    """Import Codex sessions (both active and archived)"""
    print("\n" + "=" * 60)
    print("Importing Codex messages...")
    print("=" * 60)
    
    codex_home = Path.home() / ".codex"
    target_db = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    
    target_conn = sqlite3.connect(str(target_db))
    cursor = target_conn.cursor()
    
    # Check if already completed
    cursor.execute("SELECT id, status FROM import_status WHERE source = 'codex' AND status = 'completed'")
    if cursor.fetchone():
        print("✓ Codex already imported, skipping...")
        target_conn.close()
        return
    
    # Clean up stale in_progress records
    cursor.execute("DELETE FROM import_status WHERE source = 'codex' AND status = 'in_progress'")
    target_conn.commit()
    
    # Create import status record
    cursor.execute("""
        INSERT INTO import_status (source, status, import_started_at)
        VALUES (?, ?, ?)
    """, ('codex', 'in_progress', int(time.time())))
    import_id = cursor.lastrowid
    target_conn.commit()
    
    try:
        # Find all session files (active + archived)
        import glob
        session_files = []
        session_files.extend(glob.glob(f"{codex_home}/sessions/**/*.jsonl", recursive=True))
        session_files.extend(glob.glob(f"{codex_home}/archived_sessions/*.jsonl"))
        
        print(f"Found {len(session_files):,} Codex session files (active + archived)")
        
        total_imported = 0
        skipped = 0
        start_time = time.time()
        
        for session_file in session_files:
            session_id = None
            session_timestamp = None
            session_model = None
            
            try:
                with open(session_file, 'r') as f:
                    batch = []
                    for line in f:
                        try:
                            event = json.loads(line.strip())
                            
                            # Extract session metadata from first event
                            if event.get('type') == 'session_meta':
                                payload = event.get('payload', {})
                                session_id = payload.get('id')
                                session_timestamp = payload.get('timestamp')
                                session_model = payload.get('model_provider', 'unknown')
                            
                            # Import message events
                            if session_id and event.get('timestamp'):
                                event_type = event.get('type', 'unknown')
                                timestamp_str = event.get('timestamp')
                                
                                # Parse content based on event type
                                speaker = 'system'
                                content = ''
                                content_type = 'text'
                                
                                if event_type == 'response_item':
                                    payload = event.get('payload', {})
                                    role = payload.get('role', 'unknown')
                                    speaker = 'user' if role in ['user', 'developer'] else 'assistant'
                                    
                                    content_items = payload.get('content', [])
                                    if content_items:
                                        content = json.dumps(content_items)
                                        if any('tool_use' in str(item) for item in content_items):
                                            content_type = 'tool_call'
                                        elif any('tool_result' in str(item) for item in content_items):
                                            content_type = 'tool_result'
                                
                                batch.append((
                                    'codex',
                                    session_id,
                                    None,  # turn_id
                                    timestamp_str,
                                    speaker,
                                    content,
                                    content_type,
                                    session_model,
                                    None,  # tokens
                                    json.dumps({'event_type': event_type, 'file': session_file})
                                ))
                                
                                # Batch insert every 1000 events
                                if len(batch) >= 1000:
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
                                    eta_seconds = (40000000 - total_imported) / rate if rate > 0 else 0
                                    eta_minutes = eta_seconds / 60
                                    
                                    print(f"  {total_imported:,} events ({rate:.0f}/sec, ETA: {eta_minutes:.0f}m)  ", end='\r')
                        
                        except (json.JSONDecodeError, KeyError) as e:
                            skipped += 1
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
            
            except Exception as e:
                print(f"\nError reading {session_file}: {e}")
                continue
        
        print(f"\n✓ Imported {total_imported:,} Codex events (skipped {skipped} malformed)")
        
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
        target_conn.close()


def main():
    print("Memory System Fast Import")
    print("Starting at", time.strftime("%Y-%m-%d %H:%M:%S"))
    print()
    
    start_time = time.time()
    
    import_codex()
    import_hermes()
    import_opencode()
    
    elapsed = time.time() - start_time
    print(f"\n{'=' * 60}")
    print(f"Import completed in {elapsed:.1f} seconds ({elapsed/60:.1f} minutes)")
    print(f"{'=' * 60}")
    
    # Show final counts
    target_db = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    conn = sqlite3.connect(str(target_db))
    cursor = conn.cursor()
    
    cursor.execute("SELECT COUNT(*) FROM episodic_events")
    total = cursor.fetchone()[0]
    
    cursor.execute("SELECT source, COUNT(*) FROM episodic_events GROUP BY source")
    by_source = cursor.fetchall()
    
    print("\nFinal counts:")
    for source, count in by_source:
        print(f"  {source:10s} {count:,} events")
    print(f"  {'Total':10s} {total:,} events")
    
    conn.close()


if __name__ == "__main__":
    main()

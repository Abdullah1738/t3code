#!/usr/bin/env python3
"""
Fix Codex timestamps - convert ISO strings to Unix timestamps
"""

import sqlite3
from pathlib import Path
from datetime import datetime
import time

def parse_iso_timestamp(ts_str):
    """Convert ISO timestamp to Unix timestamp"""
    try:
        # Handle various ISO formats
        if ts_str.endswith('Z'):
            ts_str = ts_str[:-1] + '+00:00'
        dt = datetime.fromisoformat(ts_str)
        return int(dt.timestamp())
    except:
        return 0

def fix_timestamps():
    db_path = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    conn = sqlite3.connect(str(db_path))
    
    # Optimize
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA cache_size = -64000")
    
    print("Fixing Codex timestamps...")
    print("=" * 60)
    
    # Process in batches
    batch_size = 100000
    offset = 0
    total_fixed = 0
    start_time = time.time()
    
    while True:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id, timestamp
            FROM episodic_events
            WHERE source = 'codex'
            LIMIT ? OFFSET ?
        """, (batch_size, offset))
        
        rows = cursor.fetchall()
        if not rows:
            break
        
        # Prepare update batch
        updates = []
        for row_id, ts_str in rows:
            if isinstance(ts_str, str):
                unix_ts = parse_iso_timestamp(ts_str)
                updates.append((unix_ts, row_id))
        
        # Batch update
        cursor.executemany("""
            UPDATE episodic_events
            SET timestamp = ?
            WHERE id = ?
        """, updates)
        
        conn.commit()
        total_fixed += len(updates)
        offset += batch_size
        
        elapsed = time.time() - start_time
        rate = total_fixed / elapsed if elapsed > 0 else 0
        eta_seconds = (50000000 - total_fixed) / rate if rate > 0 else 0
        eta_minutes = eta_seconds / 60
        
        print(f"  {total_fixed:,} timestamps fixed ({rate:.0f}/sec, ETA: {eta_minutes:.0f}m)  ", end='\r')
    
    print(f"\n✓ Fixed {total_fixed:,} Codex timestamps")
    conn.close()

if __name__ == '__main__':
    fix_timestamps()

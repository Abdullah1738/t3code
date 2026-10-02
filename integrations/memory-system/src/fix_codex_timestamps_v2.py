#!/usr/bin/env python3
"""
Fix Codex timestamps - convert ISO strings to Unix timestamps (robust version)
"""

import sqlite3
from pathlib import Path
from datetime import datetime
import time

def parse_iso_timestamp(ts_str):
    """Convert ISO timestamp to Unix timestamp"""
    try:
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
    conn.execute("PRAGMA cache_size = -128000")  # 128MB
    conn.execute("PRAGMA temp_store = MEMORY")
    
    print("Fixing remaining Codex timestamps...")
    print("=" * 60)
    
    # Count remaining
    cursor = conn.cursor()
    cursor.execute("""
        SELECT COUNT(*) FROM episodic_events 
        WHERE source = 'codex' AND typeof(timestamp) = 'text'
    """)
    total_remaining = cursor.fetchone()[0]
    print(f"Found {total_remaining:,} text timestamps to fix")
    
    # Process in batches using rowid for efficiency
    batch_size = 50000
    total_fixed = 0
    start_time = time.time()
    
    while True:
        cursor = conn.cursor()
        # Select only text timestamps
        cursor.execute("""
            SELECT rowid, timestamp
            FROM episodic_events
            WHERE source = 'codex' AND typeof(timestamp) = 'text'
            LIMIT ?
        """, (batch_size,))
        
        rows = cursor.fetchall()
        if not rows:
            break
        
        # Prepare update batch
        updates = []
        for rowid, ts_str in rows:
            unix_ts = parse_iso_timestamp(ts_str)
            updates.append((unix_ts, rowid))
        
        # Batch update
        cursor.executemany("""
            UPDATE episodic_events
            SET timestamp = ?
            WHERE rowid = ?
        """, updates)
        
        conn.commit()
        total_fixed += len(updates)
        
        elapsed = time.time() - start_time
        rate = total_fixed / elapsed if elapsed > 0 else 0
        eta_seconds = (total_remaining - total_fixed) / rate if rate > 0 else 0
        eta_minutes = eta_seconds / 60
        
        print(f"  {total_fixed:,} / {total_remaining:,} fixed ({rate:.0f}/sec, ETA: {eta_minutes:.0f}m)  ", end='\r')
    
    print(f"\n✓ Fixed {total_fixed:,} Codex timestamps")
    
    # Verify
    cursor.execute("""
        SELECT COUNT(*) FROM episodic_events 
        WHERE source = 'codex' AND typeof(timestamp) = 'text'
    """)
    remaining = cursor.fetchone()[0]
    print(f"Remaining text timestamps: {remaining:,}")
    
    conn.close()

if __name__ == '__main__':
    fix_timestamps()

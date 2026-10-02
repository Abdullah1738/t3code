#!/usr/bin/env python3
"""
Deduplicate Codex events - keep earliest occurrence of each (source, session_id, turn_id)
"""

import sqlite3
from pathlib import Path

def deduplicate():
    db_path = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    
    print("Deduplicating Codex events...")
    print()
    
    # Count before
    cursor.execute("SELECT COUNT(*) FROM episodic_events WHERE source = 'codex'")
    before = cursor.fetchone()[0]
    print(f"Before: {before:,} Codex events")
    
    # Delete duplicates, keeping the one with the lowest id (earliest inserted)
    print("Removing duplicates...")
    cursor.execute("""
        DELETE FROM episodic_events
        WHERE source = 'codex'
        AND id NOT IN (
            SELECT MIN(id)
            FROM episodic_events
            WHERE source = 'codex'
            GROUP BY source, session_id, COALESCE(turn_id, '')
        )
    """)
    
    deleted = cursor.rowcount
    conn.commit()
    
    # Count after
    cursor.execute("SELECT COUNT(*) FROM episodic_events WHERE source = 'codex'")
    after = cursor.fetchone()[0]
    
    print(f"After:  {after:,} Codex events")
    print(f"Deleted: {deleted:,} duplicates")
    print()
    
    # Verify no duplicates remain
    cursor.execute("""
        SELECT COUNT(*) as total, COUNT(DISTINCT session_id || '|' || COALESCE(turn_id, '')) as unique_keys
        FROM episodic_events
        WHERE source = 'codex'
    """)
    total, unique = cursor.fetchone()
    
    if total == unique:
        print(f"✓ Verification passed: {total:,} events, {unique:,} unique keys")
    else:
        print(f"✗ Verification failed: {total:,} events, {unique:,} unique keys")
    
    conn.close()

if __name__ == '__main__':
    deduplicate()

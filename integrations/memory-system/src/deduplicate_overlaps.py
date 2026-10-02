#!/usr/bin/env python3
"""
Deduplicate overlapping sessions:
- Codex is canonical if session exists in both Codex and Hermes
- Hermes is canonical if session exists in both Hermes and OpenCode (but not Codex)
- OpenCode is canonical if session only exists in OpenCode
"""

import sqlite3
from pathlib import Path

def deduplicate_overlaps():
    db_path = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    
    print("=" * 70)
    print("DEDUPLICATING OVERLAPPING SESSIONS")
    print("=" * 70)
    print()
    
    # Count before
    cursor.execute("SELECT source, COUNT(*) FROM episodic_events GROUP BY source")
    before = dict(cursor.fetchall())
    print("Before deduplication:")
    for source, count in before.items():
        print(f"  {source:12s} {count:>12,} events")
    print()
    
    # Find sessions that exist in both Codex and Hermes
    print("Finding Codex/Hermes overlaps...")
    cursor.execute("""
        SELECT DISTINCT c.session_id
        FROM episodic_events c
        JOIN episodic_events h ON c.session_id = h.session_id
        WHERE c.source = 'codex' AND h.source = 'hermes'
    """)
    codex_hermes_overlaps = [row[0] for row in cursor.fetchall()]
    print(f"  Found {len(codex_hermes_overlaps):,} sessions in both Codex and Hermes")
    
    # Delete Hermes events for these sessions (Codex is canonical)
    if codex_hermes_overlaps:
        placeholders = ','.join('?' * len(codex_hermes_overlaps))
        cursor.execute(f"""
            DELETE FROM episodic_events
            WHERE source = 'hermes'
            AND session_id IN ({placeholders})
        """, codex_hermes_overlaps)
        deleted_hermes = cursor.rowcount
        print(f"  Deleted {deleted_hermes:,} Hermes events (Codex is canonical)")
        print()
    
    # Find sessions that exist in both Hermes and OpenCode (but not in Codex)
    print("Finding Hermes/OpenCode overlaps...")
    cursor.execute("""
        SELECT DISTINCT h.session_id
        FROM episodic_events h
        JOIN episodic_events o ON h.session_id = o.session_id
        WHERE h.source = 'hermes' AND o.source = 'opencode'
        AND h.session_id NOT IN (SELECT session_id FROM episodic_events WHERE source = 'codex')
    """)
    hermes_opencode_overlaps = [row[0] for row in cursor.fetchall()]
    print(f"  Found {len(hermes_opencode_overlaps):,} sessions in both Hermes and OpenCode (not in Codex)")
    
    # Delete OpenCode events for these sessions (Hermes is canonical)
    if hermes_opencode_overlaps:
        placeholders = ','.join('?' * len(hermes_opencode_overlaps))
        cursor.execute(f"""
            DELETE FROM episodic_events
            WHERE source = 'opencode'
            AND session_id IN ({placeholders})
        """, hermes_opencode_overlaps)
        deleted_opencode = cursor.rowcount
        print(f"  Deleted {deleted_opencode:,} OpenCode events (Hermes is canonical)")
        print()
    
    # Find sessions that exist in all three (shouldn't happen, but check)
    print("Finding three-way overlaps...")
    cursor.execute("""
        SELECT DISTINCT c.session_id
        FROM episodic_events c
        JOIN episodic_events h ON c.session_id = h.session_id
        JOIN episodic_events o ON c.session_id = o.session_id
        WHERE c.source = 'codex' AND h.source = 'hermes' AND o.source = 'opencode'
    """)
    three_way = cursor.fetchall()
    print(f"  Found {len(three_way):,} sessions in all three sources")
    if three_way:
        print("  (These should have been handled above)")
    print()
    
    conn.commit()
    
    # Count after
    cursor.execute("SELECT source, COUNT(*) FROM episodic_events GROUP BY source")
    after = dict(cursor.fetchall())
    print("After deduplication:")
    for source in ['codex', 'hermes', 'opencode']:
        before_count = before.get(source, 0)
        after_count = after.get(source, 0)
        deleted = before_count - after_count
        print(f"  {source:12s} {after_count:>12,} events (deleted {deleted:,})")
    print()
    
    # Total
    total_before = sum(before.values())
    total_after = sum(after.values())
    total_deleted = total_before - total_after
    print(f"  {'TOTAL':12s} {total_after:>12,} events (deleted {total_deleted:,})")
    print()
    
    # Verify no overlaps remain
    print("Verifying no overlaps remain...")
    cursor.execute("""
        SELECT session_id, COUNT(DISTINCT source) as source_count
        FROM episodic_events
        GROUP BY session_id
        HAVING source_count > 1
    """)
    remaining_overlaps = cursor.fetchall()
    
    if remaining_overlaps:
        print(f"  ✗ FAIL: {len(remaining_overlaps):,} sessions still have overlaps")
        for session_id, count in remaining_overlaps[:5]:
            print(f"    {session_id}: {count} sources")
    else:
        print(f"  ✓ PASS: No overlapping sessions remain")
    print()
    
    # Session counts
    cursor.execute("""
        SELECT source, COUNT(DISTINCT session_id) as sessions
        FROM episodic_events
        GROUP BY source
    """)
    print("Unique sessions per source:")
    for source, count in cursor.fetchall():
        print(f"  {source:12s} {count:>12,} sessions")
    
    cursor.execute("SELECT COUNT(DISTINCT session_id) FROM episodic_events")
    total_sessions = cursor.fetchone()[0]
    print(f"  {'TOTAL':12s} {total_sessions:>12,} unique sessions")
    print()
    
    conn.close()
    
    print("=" * 70)
    print("DEDUPLICATION COMPLETE")
    print("=" * 70)

if __name__ == '__main__':
    deduplicate_overlaps()

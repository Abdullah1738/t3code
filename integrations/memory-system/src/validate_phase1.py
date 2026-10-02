#!/usr/bin/env python3
"""
Phase 1 Validation: Check deduplication, lineage, and chronology
"""

import sqlite3
from pathlib import Path
from datetime import datetime

def validate():
    db_path = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    conn = sqlite3.connect(str(db_path))
    
    print("=" * 70)
    print("PHASE 1 VALIDATION - Deduplication, Lineage, Chronology")
    print("=" * 70)
    print()
    
    # 1. Total counts
    print("1. TOTAL COUNTS")
    print("-" * 70)
    cursor = conn.cursor()
    cursor.execute("""
        SELECT source, COUNT(*) as count
        FROM episodic_events
        GROUP BY source
        ORDER BY source
    """)
    totals = {}
    for source, count in cursor.fetchall():
        totals[source] = count
        print(f"  {source:12s} {count:>12,} events")
    print(f"  {'TOTAL':12s} {sum(totals.values()):>12,} events")
    print()
    
    # 2. Timestamp types
    print("2. TIMESTAMP TYPES")
    print("-" * 70)
    cursor.execute("""
        SELECT source, typeof(timestamp) as ts_type, COUNT(*) as count
        FROM episodic_events
        GROUP BY source, ts_type
        ORDER BY source, ts_type
    """)
    all_integer = True
    for source, ts_type, count in cursor.fetchall():
        status = "✓" if ts_type == "integer" else "✗"
        print(f"  {status} {source:12s} {ts_type:8s} {count:>12,}")
        if ts_type != "integer":
            all_integer = False
    print(f"  Result: {'PASS' if all_integer else 'FAIL'}")
    print()
    
    # 3. Deduplication check
    print("3. DEDUPLICATION CHECK")
    print("-" * 70)
    cursor.execute("""
        SELECT source, 
               COUNT(*) as total, 
               COUNT(DISTINCT session_id || '|' || COALESCE(turn_id, '')) as unique_keys
        FROM episodic_events
        GROUP BY source
    """)
    no_dupes = True
    for source, total, unique_keys in cursor.fetchall():
        dupes = total - unique_keys
        status = "✓" if dupes == 0 else "✗"
        print(f"  {status} {source:12s} {total:>12,} total, {unique_keys:>12,} unique ({dupes:,} duplicates)")
        if dupes > 0:
            no_dupes = False
    print(f"  Result: {'PASS' if no_dupes else 'FAIL'}")
    print()
    
    # 4. Chronology per source
    print("4. CHRONOLOGY CHECK (per source)")
    print("-" * 70)
    for source in totals.keys():
        cursor.execute(f"""
            SELECT 
                MIN(timestamp) as first_ts,
                MAX(timestamp) as last_ts,
                (MAX(timestamp) - MIN(timestamp)) / 86400.0 as span_days
            FROM episodic_events
            WHERE source = ?
        """, (source,))
        first_ts, last_ts, span_days = cursor.fetchone()
        
        first_date = datetime.fromtimestamp(first_ts).strftime('%Y-%m-%d %H:%M:%S')
        last_date = datetime.fromtimestamp(last_ts).strftime('%Y-%m-%d %H:%M:%S')
        
        status = "✓" if span_days >= 0 else "✗"
        print(f"  {status} {source:12s}")
        print(f"      First: {first_date} ({first_ts})")
        print(f"      Last:  {last_date} ({last_ts})")
        print(f"      Span:  {span_days:,.1f} days")
    print()
    
    # 5. Session counts
    print("5. SESSION COUNTS")
    print("-" * 70)
    cursor.execute("""
        SELECT source, COUNT(DISTINCT session_id) as sessions
        FROM episodic_events
        GROUP BY source
        ORDER BY source
    """)
    for source, sessions in cursor.fetchall():
        print(f"  {source:12s} {sessions:>12,} sessions")
    print()
    
    # 6. Lineage check
    print("6. LINEAGE CHECK (imported sessions)")
    print("-" * 70)
    cursor.execute("""
        SELECT COUNT(DISTINCT session_id)
        FROM episodic_events
        WHERE source = 'hermes'
        AND metadata_json LIKE '%imported_from_codex%'
    """)
    hermes_from_codex = cursor.fetchone()[0]
    
    cursor.execute("""
        SELECT COUNT(DISTINCT session_id)
        FROM episodic_events
        WHERE source = 'hermes'
    """)
    total_hermes = cursor.fetchone()[0]
    
    cursor.execute("""
        SELECT COUNT(DISTINCT session_id)
        FROM episodic_events
        WHERE source = 'opencode'
        AND metadata_json LIKE '%imported_from_hermes%'
    """)
    opencode_from_hermes = cursor.fetchone()[0]
    
    cursor.execute("""
        SELECT COUNT(DISTINCT session_id)
        FROM episodic_events
        WHERE source = 'opencode'
    """)
    total_opencode = cursor.fetchone()[0]
    
    print(f"  Hermes:")
    print(f"    Total sessions:              {total_hermes:>12,}")
    print(f"    Imported from Codex:         {hermes_from_codex:>12,}")
    print(f"    Native Hermes:               {total_hermes - hermes_from_codex:>12,}")
    print()
    print(f"  OpenCode:")
    print(f"    Total sessions:              {total_opencode:>12,}")
    print(f"    Imported from Hermes:        {opencode_from_hermes:>12,}")
    print(f"    Native OpenCode:             {total_opencode - opencode_from_hermes:>12,}")
    print()
    
    # 7. Content type distribution
    print("7. CONTENT TYPE DISTRIBUTION")
    print("-" * 70)
    cursor.execute("""
        SELECT source, content_type, COUNT(*) as count
        FROM episodic_events
        GROUP BY source, content_type
        ORDER BY source, count DESC
    """)
    current_source = None
    for source, content_type, count in cursor.fetchall():
        if source != current_source:
            if current_source is not None:
                print()
            current_source = source
            print(f"  {source}:")
        pct = (count / totals[source]) * 100
        print(f"    {content_type:20s} {count:>12,} ({pct:>5.1f}%)")
    print()
    
    # 8. Speaker distribution
    print("8. SPEAKER DISTRIBUTION")
    print("-" * 70)
    cursor.execute("""
        SELECT source, speaker, COUNT(*) as count
        FROM episodic_events
        GROUP BY source, speaker
        ORDER BY source, count DESC
    """)
    current_source = None
    for source, speaker, count in cursor.fetchall():
        if source != current_source:
            if current_source is not None:
                print()
            current_source = source
            print(f"  {source}:")
        pct = (count / totals[source]) * 100
        print(f"    {speaker:20s} {count:>12,} ({pct:>5.1f}%)")
    print()
    
    # 9. Sample events from each source
    print("9. SAMPLE EVENTS (first event from each source)")
    print("-" * 70)
    for source in totals.keys():
        cursor.execute("""
            SELECT session_id, timestamp, speaker, content_type, substr(content, 1, 60)
            FROM episodic_events
            WHERE source = ?
            ORDER BY timestamp
            LIMIT 1
        """, (source,))
        session_id, ts, speaker, content_type, content_preview = cursor.fetchone()
        date_str = datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S')
        print(f"  {source:12s} {date_str}")
        print(f"    Session: {session_id[:32]}...")
        print(f"    {speaker}/{content_type}: {content_preview}...")
        print()
    
    print("=" * 70)
    print("VALIDATION COMPLETE")
    print("=" * 70)
    
    conn.close()

if __name__ == '__main__':
    validate()

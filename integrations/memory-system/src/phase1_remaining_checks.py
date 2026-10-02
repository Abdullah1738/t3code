#!/usr/bin/env python3
"""
Phase 1 Remaining Checks:
1. Verify archived sessions included
2. Check for session overlap and mark canonical sources
3. Verify tool calls, traces, and content completeness
"""

import sqlite3
import json
from pathlib import Path
from datetime import datetime
from collections import defaultdict

def check_archived_sessions():
    """Check if archived sessions from each source are included"""
    print("=" * 70)
    print("1. ARCHIVED SESSIONS CHECK")
    print("=" * 70)
    print()
    
    codex_dir = Path.home() / "Library" / "Application Support" / "Codex" / "chats"
    hermes_dir = Path.home() / ".config" / "hermes" / "chats"
    opencode_dir = Path.home() / ".config" / "openchamber" / "chats"
    
    # Check Codex archived
    codex_archived = list(codex_dir.glob("*/archived/*"))
    print(f"Codex archived directories found: {len(codex_archived)}")
    
    # Check Hermes archived
    hermes_archived = list(hermes_dir.glob("*/archived/*"))
    print(f"Hermes archived directories found: {len(hermes_archived)}")
    
    # Check OpenCode archived
    opencode_archived = list(opencode_dir.glob("*/archived/*"))
    print(f"OpenCode archived directories found: {len(opencode_archived)}")
    print()
    
    # Sample a few to check if they're in the DB
    db_path = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    
    # Check Codex archived sessions
    if codex_archived:
        print("Checking Codex archived sessions in DB...")
        sample = codex_archived[:5]
        for session_dir in sample:
            session_id = session_dir.name
            cursor.execute("SELECT COUNT(*) FROM episodic_events WHERE source='codex' AND session_id=?", (session_id,))
            count = cursor.fetchone()[0]
            status = "✓" if count > 0 else "✗"
            print(f"  {status} {session_id}: {count} events")
        print()
    
    # Check Hermes archived sessions
    if hermes_archived:
        print("Checking Hermes archived sessions in DB...")
        sample = hermes_archived[:5]
        for session_dir in sample:
            session_id = session_dir.name
            cursor.execute("SELECT COUNT(*) FROM episodic_events WHERE source='hermes' AND session_id=?", (session_id,))
            count = cursor.fetchone()[0]
            status = "✓" if count > 0 else "✗"
            print(f"  {status} {session_id}: {count} events")
        print()
    
    # Check OpenCode archived sessions
    if opencode_archived:
        print("Checking OpenCode archived sessions in DB...")
        sample = opencode_archived[:5]
        for session_dir in sample:
            session_id = session_dir.name
            cursor.execute("SELECT COUNT(*) FROM episodic_events WHERE source='opencode' AND session_id=?", (session_id,))
            count = cursor.fetchone()[0]
            status = "✓" if count > 0 else "✗"
            print(f"  {status} {session_id}: {count} events")
        print()
    
    conn.close()

def check_session_overlap():
    """Check for sessions that appear in multiple sources and determine canonical"""
    print("=" * 70)
    print("2. SESSION OVERLAP & CANONICAL SOURCE")
    print("=" * 70)
    print()
    
    db_path = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    
    # Get all session_ids grouped by source
    cursor.execute("""
        SELECT session_id, GROUP_CONCAT(source) as sources, COUNT(DISTINCT source) as source_count
        FROM (SELECT DISTINCT session_id, source FROM episodic_events)
        GROUP BY session_id
        HAVING source_count > 1
    """)
    
    overlaps = cursor.fetchall()
    print(f"Sessions appearing in multiple sources: {len(overlaps)}")
    print()
    
    if overlaps:
        print("Sample overlapping sessions:")
        for session_id, sources, count in overlaps[:10]:
            print(f"  {session_id[:40]}... appears in: {sources}")
        print()
        
        # Count by overlap pattern
        cursor.execute("""
            SELECT GROUP_CONCAT(source) as pattern, COUNT(*) as count
            FROM (
                SELECT session_id, GROUP_CONCAT(source) as source
                FROM (SELECT DISTINCT session_id, source FROM episodic_events)
                GROUP BY session_id
                HAVING COUNT(DISTINCT source) > 1
            )
            GROUP BY source
            ORDER BY count DESC
        """)
        
        print("Overlap patterns:")
        for pattern, count in cursor.fetchall():
            print(f"  {pattern}: {count} sessions")
        print()
    else:
        print("✓ No overlapping sessions found - each session is in only one source")
        print()
    
    conn.close()
    return len(overlaps)

def check_content_completeness():
    """Check that tool calls, traces, and other metadata are preserved"""
    print("=" * 70)
    print("3. CONTENT COMPLETENESS CHECK")
    print("=" * 70)
    print()
    
    db_path = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    
    # Check content types
    cursor.execute("""
        SELECT source, content_type, COUNT(*) as count
        FROM episodic_events
        GROUP BY source, content_type
        ORDER BY source, content_type
    """)
    
    print("Content type distribution:")
    print()
    current_source = None
    for source, content_type, count in cursor.fetchall():
        if source != current_source:
            if current_source is not None:
                print()
            current_source = source
            print(f"{source}:")
        print(f"  {content_type:20s} {count:>12,}")
    print()
    
    # Check for tool calls in detail
    print("Tool call analysis:")
    cursor.execute("""
        SELECT source, COUNT(*) as tool_calls
        FROM episodic_events
        WHERE content_type = 'tool_call'
        GROUP BY source
    """)
    
    for source, count in cursor.fetchall():
        print(f"  {source}: {count:,} tool calls")
        
        # Sample tool calls
        cursor.execute("""
            SELECT content
            FROM episodic_events
            WHERE source = ? AND content_type = 'tool_call'
            LIMIT 3
        """, (source,))
        
        for (content,) in cursor.fetchall():
            try:
                data = json.loads(content)
                tool_name = data.get('name', 'unknown')
                print(f"    Sample: {tool_name}")
            except:
                print(f"    Sample: [unparseable]")
    print()
    
    # Check metadata fields
    print("Metadata completeness:")
    cursor.execute("""
        SELECT source,
               COUNT(*) as total,
               SUM(CASE WHEN metadata_json IS NOT NULL AND metadata_json != '{}' THEN 1 ELSE 0 END) as with_metadata
        FROM episodic_events
        GROUP BY source
    """)
    
    for source, total, with_metadata in cursor.fetchall():
        pct = (with_metadata / total * 100) if total > 0 else 0
        print(f"  {source}: {with_metadata:,} / {total:,} events have metadata ({pct:.1f}%)")
    print()
    
    # Sample some metadata
    print("Sample metadata fields:")
    for source in ['codex', 'hermes', 'opencode']:
        cursor.execute("""
            SELECT metadata_json
            FROM episodic_events
            WHERE source = ? AND metadata_json IS NOT NULL AND metadata_json != '{}'
            LIMIT 1
        """, (source,))
        
        row = cursor.fetchone()
        if row:
            try:
                metadata = json.loads(row[0])
                keys = list(metadata.keys())[:5]
                print(f"  {source}: {', '.join(keys)}")
            except:
                print(f"  {source}: [unparseable]")
    print()
    
    conn.close()

def main():
    print()
    check_archived_sessions()
    overlap_count = check_session_overlap()
    check_content_completeness()
    
    print("=" * 70)
    print("PHASE 1 REMAINING CHECKS COMPLETE")
    print("=" * 70)
    
    return overlap_count

if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
Verify content completeness: tool calls, tool results, traces
"""

import sqlite3
import json
from pathlib import Path
from collections import Counter

def verify_content():
    db_path = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    
    print("=" * 70)
    print("CONTENT COMPLETENESS VERIFICATION")
    print("=" * 70)
    print()
    
    # Overall stats
    cursor.execute("""
        SELECT source, 
               COUNT(*) as total,
               COUNT(DISTINCT session_id) as sessions,
               COUNT(DISTINCT content_type) as content_types
        FROM episodic_events
        GROUP BY source
    """)
    
    print("Overall statistics:")
    for source, total, sessions, content_types in cursor.fetchall():
        print(f"  {source:12s} {total:>12,} events, {sessions:>8,} sessions, {content_types} content types")
    print()
    
    # Content type breakdown
    print("Content types per source:")
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
        print(f"    {content_type:20s} {count:>12,}")
    print()
    
    # Tool call details
    print("Tool call analysis:")
    cursor.execute("""
        SELECT COUNT(*) 
        FROM episodic_events
        WHERE content_type = 'tool_call'
    """)
    total_tool_calls = cursor.fetchone()[0]
    print(f"  Total tool calls across all sources: {total_tool_calls:,}")
    print()
    
    # Parse tool calls to extract tool names
    cursor.execute("""
        SELECT source, content
        FROM episodic_events
        WHERE content_type = 'tool_call'
        LIMIT 100
    """)
    
    tool_names = Counter()
    for source, content in cursor.fetchall():
        try:
            calls = json.loads(content)
            if isinstance(calls, list):
                for call in calls:
                    if isinstance(call, dict) and 'function' in call:
                        tool_name = call['function'].get('name', 'unknown')
                        tool_names[tool_name] += 1
        except:
            pass
    
    print("  Top tools used (from sample of 100 tool calls):")
    for tool, count in tool_names.most_common(10):
        print(f"    {tool:30s} {count:>4,}")
    print()
    
    # Check for tool results
    cursor.execute("""
        SELECT source, COUNT(*) as count
        FROM episodic_events
        WHERE content_type = 'tool_result'
        GROUP BY source
    """)
    
    print("Tool results:")
    has_results = False
    for source, count in cursor.fetchall():
        print(f"  {source}: {count:,} tool results")
        has_results = True
    if not has_results:
        print("  No tool results found in any source")
    print()
    
    # Check speaker distribution
    print("Speaker distribution:")
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
        print(f"    {speaker:20s} {count:>12,}")
    print()
    
    # Sample events from each source
    print("Sample events (first from each source):")
    for source in ['codex', 'hermes', 'opencode']:
        cursor.execute("""
            SELECT session_id, speaker, content_type, LENGTH(content) as content_length
            FROM episodic_events
            WHERE source = ?
            ORDER BY timestamp
            LIMIT 1
        """, (source,))
        
        row = cursor.fetchone()
        if row:
            session_id, speaker, content_type, length = row
            print(f"  {source}:")
            print(f"    Session: {session_id[:40]}...")
            print(f"    {speaker}/{content_type}, {length:,} bytes")
        print()
    
    # Check for metadata richness
    print("Metadata field analysis:")
    for source in ['codex', 'hermes', 'opencode']:
        cursor.execute("""
            SELECT metadata_json
            FROM episodic_events
            WHERE source = ? AND metadata_json IS NOT NULL AND metadata_json != '{}'
            LIMIT 10
        """, (source,))
        
        all_keys = set()
        for (metadata_json,) in cursor.fetchall():
            try:
                metadata = json.loads(metadata_json)
                all_keys.update(metadata.keys())
            except:
                pass
        
        print(f"  {source}: {', '.join(sorted(all_keys)) if all_keys else 'none'}")
    print()
    
    conn.close()
    
    print("=" * 70)
    print("VERIFICATION COMPLETE")
    print("=" * 70)

if __name__ == '__main__':
    verify_content()

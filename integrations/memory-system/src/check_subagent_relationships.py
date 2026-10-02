#!/usr/bin/env python3
"""
Check for subagent/parent session relationships in metadata
"""

import sqlite3
import json
from pathlib import Path
from collections import defaultdict

def check_relationships():
    db_path = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    
    print("=" * 70)
    print("SUBAGENT/PARENT RELATIONSHIP ANALYSIS")
    print("=" * 70)
    print()
    
    # Check for parent_session_id or similar fields
    print("Searching for parent/subagent metadata fields...")
    
    parent_fields = [
        'parent_session_id', 'parent_session', 'parent',
        'spawned_by', 'created_by', 'caller_session',
        'task_id', 'parent_task', 'delegated_from'
    ]
    
    relationships = defaultdict(int)
    
    for source in ['codex', 'hermes', 'opencode']:
        cursor.execute("""
            SELECT session_id, metadata_json
            FROM episodic_events
            WHERE source = ?
            AND metadata_json IS NOT NULL
            AND metadata_json != '{}'
        """, (source,))
        
        source_relationships = 0
        sample_relationships = []
        
        for session_id, metadata_json in cursor.fetchall():
            try:
                metadata = json.loads(metadata_json)
                
                # Check for any parent-related fields
                for field in parent_fields:
                    if field in metadata and metadata[field]:
                        relationships[f"{source}:{field}"] += 1
                        source_relationships += 1
                        if len(sample_relationships) < 3:
                            sample_relationships.append({
                                'session': session_id[:40],
                                'field': field,
                                'value': str(metadata[field])[:40]
                            })
                        break
            except:
                pass
        
        print(f"\n  {source}:")
        if source_relationships > 0:
            print(f"    Found {source_relationships:,} sessions with parent/subagent metadata")
            for rel in sample_relationships:
                print(f"      {rel['session']}... has {rel['field']}={rel['value']}...")
        else:
            print(f"    No parent/subagent relationships found")
    
    print()
    
    if relationships:
        print("Relationship field summary:")
        for field, count in sorted(relationships.items(), key=lambda x: x[1], reverse=True):
            print(f"  {field:40s} {count:>8,}")
    else:
        print("No parent/subagent metadata fields found in any source")
    
    print()
    
    # Check OpenCode for task delegation patterns
    print("Checking OpenCode for task delegation patterns...")
    cursor.execute("""
        SELECT content
        FROM episodic_events
        WHERE source = 'opencode'
        AND speaker = 'user'
        AND content LIKE '%task_id%'
        LIMIT 5
    """)
    
    task_mentions = cursor.fetchall()
    if task_mentions:
        print(f"  Found {len(task_mentions)} user messages mentioning 'task_id'")
    else:
        print("  No task_id mentions found in user messages")
    
    print()
    
    # Check for session.dispatch or session.create patterns
    print("Checking for session spawning patterns...")
    cursor.execute("""
        SELECT content
        FROM episodic_events
        WHERE source = 'opencode'
        AND content LIKE '%session.dispatch%'
        OR content LIKE '%session.create%'
        OR content LIKE '%task.create%'
        LIMIT 5
    """)
    
    spawn_patterns = cursor.fetchall()
    if spawn_patterns:
        print(f"  Found {len(spawn_patterns)} events with session spawning patterns")
        for (content,) in spawn_patterns[:2]:
            print(f"    Sample: {content[:100]}...")
    else:
        print("  No session spawning patterns found")
    
    print()
    
    conn.close()
    
    print("=" * 70)
    print("RELATIONSHIP ANALYSIS COMPLETE")
    print("=" * 70)

if __name__ == '__main__':
    check_relationships()

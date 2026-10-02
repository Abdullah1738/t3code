#!/usr/bin/env python3
"""Test import with a small sample"""

import sys
sys.path.insert(0, '/Users/ardud/.local/share/memory-system/src')

from import_pipeline import HermesImporter, OpenCodeImporter, MemoryImporter
from pathlib import Path

def test_hermes_sample():
    """Test Hermes import with first 100 messages"""
    print("Testing Hermes import (sample)...")
    db_path = Path.home() / ".hermes" / "state.db"
    
    import sqlite3
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM messages WHERE active = 1")
    total = cursor.fetchone()[0]
    print(f"  Total Hermes messages available: {total:,}")
    
    # Get just first 5 for test
    cursor.execute("""
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
        WHERE m.active = 1
        ORDER BY m.timestamp
        LIMIT 5
    """)
    
    events = []
    for row in cursor.fetchall():
        events.append({
            'id': row[0],
            'session_id': row[1],
            'role': row[2],
            'content': row[3],
            'timestamp': row[7],
            'model': row[9]
        })
    conn.close()
    
    if events:
        sample = events[0]
        print(f"  Sample event:")
        print(f"    ID: {sample['id']}")
        print(f"    Session: {sample['session_id']}")
        print(f"    Role: {sample['role']}")
        print(f"    Content length: {len(sample['content'] or '')} chars")
        print(f"    Content preview: {(sample['content'] or '')[:100]}...")
        print(f"    Model: {sample['model']}")
        print(f"    Timestamp: {sample['timestamp']}")

def test_opencode_sample():
    """Test OpenCode import with first 100 messages"""
    print("\nTesting OpenCode import (100 messages)...")
    db_path = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
    
    import sqlite3
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM message")
    total = cursor.fetchone()[0]
    conn.close()
    
    print(f"  Total OpenCode messages in DB: {total:,}")
    
    # Get just first 10 for test
    events = []
    for i, event in enumerate(OpenCodeImporter.extract_events(db_path)):
        events.append(event)
        if i >= 10:
            break
    
    if events:
        sample = events[0]
        print(f"  Sample event:")
        print(f"    Source: {sample.source}")
        print(f"    Session: {sample.session_id}")
        print(f"    Speaker: {sample.speaker}")
        print(f"    Content length: {len(sample.content)} chars")
        print(f"    Content preview: {sample.content[:100]}...")
        print(f"    Model: {sample.model}")
        print(f"    Tokens: {sample.tokens_used}")

if __name__ == "__main__":
    test_hermes_sample()
    test_opencode_sample()

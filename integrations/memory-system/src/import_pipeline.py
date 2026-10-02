#!/usr/bin/env python3
"""
Memory System Import Pipeline
Imports from Codex, Hermes, and OpenCode into the three-parallel-stores architecture
"""

import sqlite3
import json
import time
from pathlib import Path
from typing import Iterator, Dict, Any, Optional
from dataclasses import dataclass
import hashlib


@dataclass
class Event:
    """Represents a single episodic event"""
    source: str  # 'codex', 'hermes', 'opencode'
    session_id: str
    turn_id: Optional[str]
    timestamp: int
    speaker: str  # 'user', 'assistant', 'system'
    content: str
    content_type: str  # 'text', 'tool_call', 'tool_result', 'code', 'error'
    model: Optional[str] = None
    tokens_used: Optional[int] = None
    metadata: Optional[Dict[str, Any]] = None


class MemoryImporter:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        
    def import_source(self, source: str, event_iterator: Iterator[Event]) -> Dict[str, Any]:
        """Import events from a source"""
        cursor = self.conn.cursor()
        
        # Start import tracking
        cursor.execute("""
            INSERT INTO import_status (source, import_started_at, status)
            VALUES (?, ?, 'in_progress')
        """, (source, int(time.time())))
        import_id = cursor.lastrowid
        self.conn.commit()
        
        total_events = 0
        batch = []
        batch_size = 1000
        
        try:
            for event in event_iterator:
                batch.append((
                    event.source,
                    event.session_id,
                    event.turn_id,
                    event.timestamp,
                    event.speaker,
                    event.content,
                    event.content_type,
                    event.model,
                    event.tokens_used,
                    json.dumps(event.metadata) if event.metadata else None
                ))
                
                if len(batch) >= batch_size:
                    self._insert_batch(cursor, batch)
                    total_events += len(batch)
                    batch = []
                    print(f"Imported {total_events} events from {source}...")
            
            # Insert remaining batch
            if batch:
                self._insert_batch(cursor, batch)
                total_events += len(batch)
            
            # Mark import complete
            cursor.execute("""
                UPDATE import_status
                SET import_completed_at = ?,
                    total_events = ?,
                    status = 'completed'
                WHERE id = ?
            """, (int(time.time()), total_events, import_id))
            
            self.conn.commit()
            
            return {
                'source': source,
                'total_events': total_events,
                'status': 'completed'
            }
            
        except Exception as e:
            cursor.execute("""
                UPDATE import_status
                SET status = 'failed',
                    error_message = ?
                WHERE id = ?
            """, (str(e), import_id))
            self.conn.commit()
            raise
    
    def _insert_batch(self, cursor, batch):
        """Insert a batch of events"""
        cursor.executemany("""
            INSERT OR IGNORE INTO episodic_events
            (source, session_id, turn_id, timestamp, speaker, content, 
             content_type, model, tokens_used, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, batch)
        
        # Queue for consolidation
        cursor.execute("""
            INSERT INTO consolidation_queue (event_id, queued_at, status)
            SELECT id, ?, 'pending'
            FROM episodic_events
            WHERE id NOT IN (SELECT event_id FROM consolidation_queue)
        """, (int(time.time()),))
    
    def close(self):
        self.conn.close()


class CodexImporter:
    """Import from Codex session history"""
    
    @staticmethod
    def find_codex_db() -> Optional[Path]:
        """Find the Codex database"""
        possible_paths = [
            Path.home() / ".codex" / "state.db",
            Path.home() / ".codex" / "codex.db",
        ]
        for path in possible_paths:
            if path.exists():
                return path
        return None
    
    @staticmethod
    def extract_events(db_path: Path) -> Iterator[Event]:
        """Extract events from Codex database"""
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        # Check what tables exist
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [row[0] for row in cursor.fetchall()]
        print(f"Codex tables: {tables}")
        
        # Try to find conversation/message tables
        # This is a placeholder - need to inspect actual Codex schema
        if 'messages' in tables:
            cursor.execute("""
                SELECT * FROM messages ORDER BY timestamp
            """)
            
            for row in cursor.fetchall():
                # Adapt based on actual Codex schema
                yield Event(
                    source='codex',
                    session_id=row.get('session_id', 'unknown'),
                    turn_id=row.get('id') or row.get('message_id'),
                    timestamp=row.get('timestamp', 0),
                    speaker=row.get('role', 'user'),
                    content=row.get('content', ''),
                    content_type='text',
                    model=row.get('model'),
                    metadata={'raw_row': dict(row)}
                )
        
        conn.close()


class HermesImporter:
    """Import from Hermes session history"""
    
    @staticmethod
    def find_hermes_db() -> Optional[Path]:
        """Find the Hermes database"""
        path = Path.home() / ".hermes" / "state.db"
        return path if path.exists() else None
    
    @staticmethod
    def extract_events(db_path: Path) -> Iterator[Event]:
        """Extract events from Hermes database"""
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        # Hermes schema: sessions + messages
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
        """)
        
        for row in cursor.fetchall():
            # Determine content type
            content_type = 'text'
            content = row['content'] or ''
            
            if row['tool_calls']:
                content_type = 'tool_call'
                content = row['tool_calls']
            elif row['tool_call_id']:
                content_type = 'tool_result'
            
            yield Event(
                source='hermes',
                session_id=row['session_id'],
                turn_id=str(row['id']),
                timestamp=int(row['timestamp']),
                speaker=row['role'],
                content=content,
                content_type=content_type,
                model=row['model'],
                tokens_used=row['token_count'],
                metadata={
                    'session_name': row['display_name'],
                    'tool_name': row['tool_name']
                }
            )
        
        conn.close()


class OpenCodeImporter:
    """Import from OpenCode/OpenChamber session history"""
    
    @staticmethod
    def find_opencode_db() -> Optional[Path]:
        """Find the OpenCode database"""
        path = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
        return path if path.exists() else None
    
    @staticmethod
    def extract_events(db_path: Path) -> Iterator[Event]:
        """Extract events from OpenCode database"""
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        # OpenCode schema: message table with JSON data column
        cursor.execute("""
            SELECT 
                id,
                session_id,
                time_created,
                data
            FROM message
            ORDER BY time_created
        """)
        
        for row in cursor.fetchall():
            try:
                data = json.loads(row['data'])
                
                # Extract role and content
                role = data.get('role', 'user')
                
                # Content can be in various places
                content = ''
                content_type = 'text'
                
                if 'text' in data:
                    content = data['text']
                elif 'content' in data:
                    content = data['content']
                elif 'parts' in data:
                    # Multi-part message
                    content = json.dumps(data['parts'])
                    content_type = 'text'
                
                # Check for tool calls
                if 'toolCalls' in data or 'tool_calls' in data:
                    content_type = 'tool_call'
                
                yield Event(
                    source='opencode',
                    session_id=row['session_id'],
                    turn_id=row['id'],
                    timestamp=row['time_created'] // 1000,  # Convert from ms to seconds
                    speaker=role,
                    content=content,
                    content_type=content_type,
                    model=data.get('model', {}).get('modelID') if isinstance(data.get('model'), dict) else None,
                    tokens_used=data.get('tokens', {}).get('total') if isinstance(data.get('tokens'), dict) else None,
                    metadata={
                        'agent': data.get('agent'),
                        'mode': data.get('mode')
                    }
                )
            except (json.JSONDecodeError, KeyError) as e:
                # Skip malformed messages
                print(f"Warning: Skipping message {row['id']}: {e}")
                continue
        
        conn.close()


def main():
    """Run the import pipeline"""
    memory_db = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
    importer = MemoryImporter(str(memory_db))
    
    print("=" * 60)
    print("Memory System Import Pipeline")
    print("=" * 60)
    
    # Import from Codex
    print("\n1. Importing from Codex...")
    codex_db = CodexImporter.find_codex_db()
    if codex_db:
        print(f"   Found: {codex_db}")
        events = CodexImporter.extract_events(codex_db)
        result = importer.import_source('codex', events)
        print(f"   ✓ {result['total_events']} events imported")
    else:
        print("   ⚠ Codex database not found")
    
    # Import from Hermes
    print("\n2. Importing from Hermes...")
    hermes_db = HermesImporter.find_hermes_db()
    if hermes_db:
        print(f"   Found: {hermes_db}")
        events = HermesImporter.extract_events(hermes_db)
        result = importer.import_source('hermes', events)
        print(f"   ✓ {result['total_events']} events imported")
    else:
        print("   ⚠ Hermes database not found")
    
    # Import from OpenCode
    print("\n3. Importing from OpenCode...")
    opencode_db = OpenCodeImporter.find_opencode_db()
    if opencode_db:
        print(f"   Found: {opencode_db}")
        events = OpenCodeImporter.extract_events(opencode_db)
        result = importer.import_source('opencode', events)
        print(f"   ✓ {result['total_events']} events imported")
    else:
        print("   ⚠ OpenCode database not found")
    
    # Summary
    print("\n" + "=" * 60)
    print("Import Summary")
    print("=" * 60)
    cursor = importer.conn.cursor()
    cursor.execute("""
        SELECT source, total_events, status
        FROM import_status
        ORDER BY import_started_at DESC
        LIMIT 3
    """)
    for row in cursor.fetchall():
        print(f"  {row[0]:10s} {row[1]:8d} events  [{row[2]}]")
    
    cursor.execute("SELECT COUNT(*) FROM episodic_events")
    total = cursor.fetchone()[0]
    print(f"\nTotal episodic events: {total:,}")
    
    importer.close()


if __name__ == "__main__":
    main()

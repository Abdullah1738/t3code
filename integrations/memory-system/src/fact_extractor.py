#!/usr/bin/env python3
"""
Semantic Fact Extractor using surplus/glm-5.3-flash

Extracts structured facts from conversation turns with quality judgment.
Uses the MemReader pattern: selective writing, not exhaustive extraction.
"""

import os
import sys
import sqlite3
import json
import urllib.request
import urllib.error
from typing import Dict, List, Optional, Any
from pathlib import Path
from datetime import datetime
from dataclasses import dataclass


@dataclass
class ExtractedFact:
    """A fact extracted from conversation"""
    fact_type: str  # decision, preference, profile, solved_problem, workflow, constraint
    subject: str
    predicate: str
    object: str
    statement: str
    confidence: float


class FactExtractor:
    """Extract structured facts using LLM"""
    
    def __init__(self, api_key: str, model: str = "glm-5.3-flash"):
        self.api_key = api_key
        self.model = model
        self.base_url = "https://api.surplusintelligence.ai/v1"  # from ~/.config/opencode/opencode.jsonc provider.surplus
    
    def extract_facts(self, content: str, context: Dict[str, Any]) -> List[ExtractedFact]:
        """
        Extract facts from a conversation turn.
        
        Uses structured output format to ensure quality.
        """
        
        system_prompt = """You are a selective memory extraction system. Your job is to extract ONLY high-value facts worth remembering long-term.

Value hierarchy (remember these):
1. **Decisions**: Explicit policies, rules, constraints ("never do X", "always Y")
2. **Preferences**: User likes/dislikes, habits, favorites
3. **Profile**: Personal information (name, credentials, contact info, accounts)
4. **Solved problems**: Technical solutions, workarounds that worked
5. **Workflows**: Established processes, standard approaches
6. **Constraints**: Technical or business limitations

DO NOT extract:
- Chatter, greetings, acknowledgments
- Temporary task instructions
- Generic technical discussion without decisions
- Questions without answers
- Implementation details already in code

For each fact, output JSON:
{
  "fact_type": "decision|preference|profile|solved_problem|workflow|constraint",
  "subject": "what this is about",
  "predicate": "the relationship or action",
  "object": "the value or target",
  "statement": "natural language fact",
  "confidence": 0.0-1.0
}

If no facts worth remembering, return empty array []."""

        user_prompt = f"""Context:
- Speaker: {context.get('speaker', 'unknown')}
- Session: {context.get('session_id', 'unknown')}

Content:
{content}

Extract facts worth remembering:"""

        try:
            print(f"Calling API with {len(content)} chars of conversation...")
            body = json.dumps({
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                "temperature": 0.3,
                "response_format": {"type": "json_object"}
            }).encode()
            req = urllib.request.Request(
                f"{self.base_url}/chat/completions",
                data=body,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json"
                }
            )
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    result = json.loads(resp.read())
            except urllib.error.HTTPError as e:
                print(f"API error: {e.code} - {e.read()[:500]}")
                return []

            content_text = result['choices'][0]['message']['content']
            print(f"API response content length: {len(content_text)} chars")
            
            # Parse JSON response
            facts_data = json.loads(content_text)
            print(f"Parsed JSON: {type(facts_data)}")
            
            # Handle both array and object with "facts" key
            if isinstance(facts_data, list):
                facts_list = facts_data
            elif isinstance(facts_data, dict) and 'facts' in facts_data:
                facts_list = facts_data['facts']
            else:
                return []
            
            # Convert to ExtractedFact objects
            extracted = []
            for fact_dict in facts_list:
                try:
                    extracted.append(ExtractedFact(
                        fact_type=fact_dict['fact_type'],
                        subject=fact_dict['subject'],
                        predicate=fact_dict['predicate'],
                        object=fact_dict['object'],
                        statement=fact_dict['statement'],
                        confidence=float(fact_dict.get('confidence', 0.8))
                    ))
                except (KeyError, ValueError) as e:
                    print(f"Skipping malformed fact: {e}")
                    continue
            
            return extracted
            
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"API timeout/connection error: {e}")
            return []
        except Exception as e:
            print(f"Extraction error: {e}")
            return []


class SessionFactExtractor:
    """Extract facts from sessions in the episodic store"""
    
    def __init__(self, db_path: str, api_key: str):
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self.extractor = FactExtractor(api_key)
    
    def get_high_value_sessions(self, limit: int = 100) -> List[Dict]:
        """
        Get sessions likely to contain high-value facts.
        
        Strategy: Start with most recent sessions regardless of date,
        pick ones with decent event count (50+)
        """
        cursor = self.conn.cursor()
        
        # Check if we've processed sessions before
        cursor.execute("SELECT COUNT(*) as count FROM extraction_metadata")
        processed_count = cursor.fetchone()['count']
        
        if processed_count > 0:
            # Get sessions not yet processed
            cursor.execute("""
                SELECT session_id, COUNT(id) as event_count, MIN(timestamp) as start_time
                FROM episodic_events
                WHERE session_id NOT IN (SELECT session_id FROM extraction_metadata)
                  AND content_type = 'text'
                GROUP BY session_id
                HAVING event_count >= 50
                ORDER BY start_time DESC
                LIMIT ?
            """, (limit,))
        else:
            # First run: get most recent high-value sessions (any date)
            cursor.execute("""
                SELECT session_id, COUNT(id) as event_count, MIN(timestamp) as start_time
                FROM episodic_events
                WHERE content_type = 'text'
                GROUP BY session_id
                HAVING event_count >= 50
                ORDER BY start_time DESC
                LIMIT ?
            """, (limit,))
        
        sessions = []
        for row in cursor.fetchall():
            sessions.append(dict(row))
        
        return sessions
    
    def sample_session_events(self, session_id: str, max_events: int = 100) -> List[Dict]:
        """
        Sample events from a session intelligently.
        
        Strategy: first 30 + middle 40 + last 30
        """
        cursor = self.conn.cursor()
        
        # Get total event count
        cursor.execute("""
            SELECT COUNT(*) as total FROM episodic_events
            WHERE session_id = ? AND content_type = 'text'
        """, (session_id,))
        total = cursor.fetchone()['total']
        
        if total <= max_events:
            # Take all
            cursor.execute("""
                SELECT * FROM episodic_events
                WHERE session_id = ? AND content_type = 'text'
                ORDER BY id ASC
            """, (session_id,))
        else:
            # Sample: first 30, middle 40, last 30
            first_30 = []
            cursor.execute("""
                SELECT * FROM episodic_events
                WHERE session_id = ? AND content_type = 'text'
                ORDER BY id ASC
                LIMIT 30
            """, (session_id,))
            first_30 = [dict(row) for row in cursor.fetchall()]
            
            # Middle 40
            middle_start = (total - 40) // 2
            cursor.execute("""
                SELECT * FROM episodic_events
                WHERE session_id = ? AND content_type = 'text'
                ORDER BY id ASC
                LIMIT 40 OFFSET ?
            """, (session_id, middle_start))
            middle_40 = [dict(row) for row in cursor.fetchall()]
            
            # Last 30
            cursor.execute("""
                SELECT * FROM episodic_events
                WHERE session_id = ? AND content_type = 'text'
                ORDER BY id DESC
                LIMIT 30
            """, (session_id,))
            last_30 = [dict(row) for row in cursor.fetchall()]
            last_30.reverse()
            
            return first_30 + middle_40 + last_30
        
        events = []
        for row in cursor.fetchall():
            events.append(dict(row))
        
        return events
    
    def extract_from_session(self, session_id: str) -> Dict[str, Any]:
        """
        Extract facts from a single session.
        
        Returns extraction stats.
        """
        print(f"\n{'='*80}")
        print(f"Processing session: {session_id}")
        print(f"{'='*80}")
        
        # Sample events
        events = self.sample_session_events(session_id)
        print(f"Sampled {len(events)} events from session")
        
        stats = {
            'session_id': session_id,
            'events_processed': len(events),
            'facts_extracted': 0,
            'facts_buffered': 0,
            'facts_ignored': 0,
            'cost_dollars': 0.0
        }
        
        # Process each event
        from active_memory_manager import ActiveMemoryManager, MemoryCandidate
        memory_manager = ActiveMemoryManager(self.db_path)
        
        processed_count = 0
        for event in events:
            content = event.get('content', '')
            if not content or len(content) < 10:
                if processed_count < 3:
                    print(f"  Skipping event {event['id']}: content too short ({len(content)} chars)")
                stats['facts_ignored'] += 1
                continue
            
            processed_count += 1
            if processed_count <= 3:
                print(f"  Processing event {event['id']}: {len(content)} chars, speaker={event.get('speaker', 'unknown')}")
            
            speaker = event.get('speaker', 'unknown')
            
            # Value assessment first
            context = {
                'session_id': session_id,
                'speaker': speaker,
                'event_id': event['id'],
                'timestamp': event['timestamp']
            }
            
            assessment = memory_manager.assess_value(content, context)
            
            if not assessment['should_remember']:
                stats['facts_ignored'] += 1
                if stats['facts_ignored'] <= 3:
                    print(f"  Skipped event (reason: {assessment.get('reason', 'unknown')})")
                continue
            
            # Extract facts using LLM
            extracted_facts = self.extractor.extract_facts(content, context)
            
            if not extracted_facts:
                stats['facts_ignored'] += 1
                continue
            
            # Store each fact
            for fact in extracted_facts:
                candidate = MemoryCandidate(
                    fact_type=fact.fact_type,
                    subject=fact.subject,
                    predicate=fact.predicate,
                    object=fact.object,
                    statement=fact.statement,
                    confidence=fact.confidence,
                    source_event_id=event['id'],
                    timestamp=event['timestamp']
                )
                
                try:
                    fact_id = memory_manager.add_memory(candidate)
                    stats['facts_extracted'] += 1
                    print(f"  ✓ Extracted: [{fact.fact_type}] {fact.statement}")
                except Exception as e:
                    print(f"  ✗ Failed to store fact: {e}")
                    stats['facts_buffered'] += 1
        
        memory_manager.close()
        
        # Record extraction metadata
        cursor = self.conn.cursor()
        cursor.execute("""
            INSERT INTO extraction_metadata 
            (session_id, extracted_at, events_processed, facts_extracted, 
             facts_buffered, facts_ignored, model, cost_dollars)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            session_id,
            int(datetime.now().timestamp()),
            stats['events_processed'],
            stats['facts_extracted'],
            stats['facts_buffered'],
            stats['facts_ignored'],
            self.extractor.model,
            stats['cost_dollars']
        ))
        self.conn.commit()
        
        print(f"\nExtraction complete:")
        print(f"  Facts extracted: {stats['facts_extracted']}")
        print(f"  Facts ignored: {stats['facts_ignored']}")
        
        return stats
    
    def close(self):
        self.conn.close()


def main():
    """Test extraction on a few recent sessions"""
    
    # Load API key
    api_key_file = Path.home() / ".config/opencode/surplus-token"
    if not api_key_file.exists():
        print(f"Error: API key file not found at {api_key_file}")
        sys.exit(1)
    
    api_key = api_key_file.read_text().strip()
    
    db_path = Path.home() / ".local/share/memory-system/data/memory.db"
    
    extractor = SessionFactExtractor(str(db_path), api_key)
    
    try:
        if len(sys.argv) > 1:
            # Explicit session IDs from the command line
            session_ids = sys.argv[1:]
        else:
            # Default: 5 most recently-active sessions. Scan a bounded window of
            # recent events via idx_episodic_timestamp instead of a
            # DISTINCT/ORDER BY over all 8M rows.
            cursor = extractor.conn.cursor()
            cursor.execute("""
                SELECT session_id
                FROM episodic_events
                ORDER BY timestamp DESC
                LIMIT 5000
            """)
            seen = []
            for (sid,) in cursor.fetchall():
                if sid not in seen:
                    seen.append(sid)
                    if len(seen) == 5:
                        break
            session_ids = seen
        
        print(f"Testing extraction on {len(session_ids)} recent sessions")
        
        total_stats = {
            'sessions_processed': 0,
            'facts_extracted': 0,
            'facts_ignored': 0
        }
        
        for session_id in session_ids:
            stats = extractor.extract_from_session(session_id)
            total_stats['sessions_processed'] += 1
            total_stats['facts_extracted'] += stats['facts_extracted']
            total_stats['facts_ignored'] += stats['facts_ignored']
        
        print(f"\n{'='*80}")
        print("TOTAL STATS")
        print(f"{'='*80}")
        print(f"Sessions processed: {total_stats['sessions_processed']}")
        print(f"Facts extracted: {total_stats['facts_extracted']}")
        print(f"Facts ignored: {total_stats['facts_ignored']}")
        
    finally:
        extractor.close()


if __name__ == "__main__":
    main()

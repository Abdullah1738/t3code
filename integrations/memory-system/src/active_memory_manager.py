#!/usr/bin/env python3
"""
Active Memory Manager (MemReader-inspired)

Key insight from research: Quality comes from selective writing, not exhaustive extraction.

Four tools:
1. add_memory - Store atomic fact
2. search_memory - Disambiguate reference
3. buffer_memory - Hold incomplete info
4. ignore_memory - Discard low-value chatter

Value judgment dimensions:
- Decision: Explicit choices, policies, constraints
- Preference: User likes/dislikes, habits
- Knowledge: Factual information (name, passport, credentials)
- Solved problem: Technical solutions, workarounds
- Workflow: Established processes, patterns
- Constraint: Technical/business limitations

Quality gates:
- Ambiguity detection (pronouns, vague references)
- Completeness check (can store now or needs clarification?)
- Supersession detection (does this replace an older fact?)
"""

import os
import sqlite3
import json
from dataclasses import dataclass, asdict
from typing import Optional, List, Dict, Any
from pathlib import Path
from datetime import datetime


@dataclass
class MemoryCandidate:
    """A potential fact to remember"""
    fact_type: str  # decision, preference, knowledge, solved_problem, workflow, constraint
    subject: str
    predicate: str
    object: str
    statement: str
    confidence: float
    source_event_id: int
    timestamp: int
    
    # Value assessment
    should_remember: bool = True
    buffer_reason: Optional[str] = None  # ambiguous, incomplete, needs_clarification
    ignore_reason: Optional[str] = None  # chatter, off_topic, already_known


class ActiveMemoryManager:
    """Manages memory with value judgment and selective writing"""
    
    def __init__(self, db_path: str, model_endpoint: Optional[str] = None):
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self.model_endpoint = model_endpoint or os.getenv("OPENCODE_MODEL_ENDPOINT")
    
    def assess_value(self, content: str, context: Dict[str, Any]) -> Dict[str, Any]:
        """
        Value judgment: Is this worth remembering?
        
        Returns:
        {
            "should_remember": bool,
            "reason": str,
            "confidence": float,
            "fact_type": Optional[str]
        }
        """
        # Simple rule-based assessment (can be upgraded to LLM later)
        content_lower = content.lower()
        
        # High-value signals
        decision_signals = ["never", "always", "don't", "shouldn't", "policy", "rule"]
        preference_signals = ["prefer", "like", "dislike", "favorite", "usual"]
        knowledge_signals = ["my name is", "passport", "airline", "phone", "email", "address"]
        problem_signals = ["fixed", "solved", "workaround", "solution", "works by"]
        workflow_signals = ["workflow", "process", "always do", "standard approach"]
        
        # Low-value signals
        chatter_signals = ["lol", "haha", "ok", "sure", "thanks", "cool"]
        
        # Check for low-value chatter
        if any(sig in content_lower for sig in chatter_signals) and len(content.split()) < 5:
            return {
                "should_remember": False,
                "reason": "Low-value chatter",
                "confidence": 0.9,
                "fact_type": None
            }
        
        # Check for high-value content
        if any(sig in content_lower for sig in decision_signals):
            return {
                "should_remember": True,
                "reason": "Contains decision or policy",
                "confidence": 0.85,
                "fact_type": "decision"
            }
        
        if any(sig in content_lower for sig in preference_signals):
            return {
                "should_remember": True,
                "reason": "Contains preference",
                "confidence": 0.8,
                "fact_type": "preference"
            }
        
        if any(sig in content_lower for sig in knowledge_signals):
            return {
                "should_remember": True,
                "reason": "Contains personal knowledge",
                "confidence": 0.9,
                "fact_type": "profile"
            }
        
        if any(sig in content_lower for sig in problem_signals):
            return {
                "should_remember": True,
                "reason": "Contains solved problem",
                "confidence": 0.85,
                "fact_type": "solved_problem"
            }
        
        if any(sig in content_lower for sig in workflow_signals):
            return {
                "should_remember": True,
                "reason": "Contains workflow",
                "confidence": 0.8,
                "fact_type": "workflow"
            }
        
        # Medium-value: technical content over certain length
        if len(content.split()) > 20 and context.get("speaker") == "user":
            return {
                "should_remember": True,
                "reason": "Substantial user content",
                "confidence": 0.6,
                "fact_type": "knowledge"
            }
        
        # Default: don't remember
        return {
            "should_remember": False,
            "reason": "No clear signal",
            "confidence": 0.7,
            "fact_type": None
        }
    
    def detect_ambiguity(self, content: str) -> List[str]:
        """
        Detect ambiguous references that need disambiguation.
        Returns list of ambiguous elements.
        """
        ambiguous = []
        content_lower = content.lower()
        
        # Pronouns
        pronouns = ["it", "this", "that", "they", "them", "he", "she"]
        for pronoun in pronouns:
            if f" {pronoun} " in f" {content_lower} ":
                ambiguous.append(f"pronoun:{pronoun}")
        
        # Vague references
        vague_refs = ["like we discussed", "as before", "the usual", "same as last time"]
        for ref in vague_refs:
            if ref in content_lower:
                ambiguous.append(f"vague_reference:{ref}")
        
        return ambiguous
    
    def is_complete(self, content: str, ambiguities: List[str]) -> bool:
        """
        Completeness check: Can we store this now or need clarification?
        """
        # If ambiguous and content is short, it's incomplete
        if ambiguities and len(content.split()) < 10:
            return False
        
        # If it's a decision/preference but lacks the object, it's incomplete
        content_lower = content.lower()
        if any(word in content_lower for word in ["prefer", "never", "always"]):
            # Check if there's a clear object
            if content.endswith("...") or "?" in content:
                return False
        
        return True
    
    def search_memory(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        """Search existing memory to disambiguate references"""
        cursor = self.conn.cursor()
        
        # Use FTS5 for search
        cursor.execute("""
            SELECT f.*, rank
            FROM semantic_facts f
            JOIN semantic_fts ON semantic_fts.rowid = f.id
            WHERE semantic_fts MATCH ?
              AND f.is_active = 1
            ORDER BY rank
            LIMIT ?
        """, (query, limit))
        
        results = []
        for row in cursor.fetchall():
            results.append(dict(row))
        
        return results
    
    def buffer_memory(self, content: str, session_id: str, reason: str, metadata: Optional[Dict] = None) -> int:
        """Buffer incomplete information for later resolution"""
        cursor = self.conn.cursor()
        cursor.execute("""
            INSERT INTO memory_buffer (session_id, content, buffer_reason, created_at, metadata_json)
            VALUES (?, ?, ?, ?, ?)
        """, (session_id, content, reason, int(datetime.now().timestamp()), json.dumps(metadata or {})))
        
        self.conn.commit()
        return cursor.lastrowid
    
    def add_memory(self, candidate: MemoryCandidate) -> int:
        """Store a fact in semantic memory"""
        cursor = self.conn.cursor()
        
        # Check for existing duplicates or conflicts first
        from supersession_detector import SupersessionDetector
        detector = SupersessionDetector(self.db_path)
        
        # Insert the fact
        cursor.execute("""
            INSERT INTO semantic_facts 
            (fact_type, subject, predicate, object, statement, source_event_id, 
             extracted_at, confidence, valid_from, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        """, (
            candidate.fact_type,
            candidate.subject,
            candidate.predicate,
            candidate.object,
            candidate.statement,
            candidate.source_event_id,
            candidate.timestamp,
            candidate.confidence,
            candidate.timestamp
        ))
        
        fact_id = cursor.lastrowid
        self.conn.commit()
        
        # Build a Fact object for conflict detection
        from supersession_detector import Fact
        fact = Fact(
            id=fact_id,
            fact_type=candidate.fact_type,
            subject=candidate.subject,
            predicate=candidate.predicate,
            object=candidate.object,
            statement=candidate.statement,
            source_event_id=candidate.source_event_id,
            extracted_at=candidate.timestamp,
            confidence=candidate.confidence,
            supersedes_id=None,
            superseded_by_id=None,
            valid_from=candidate.timestamp,
            valid_until=None,
            is_active=1
        )
        
        # Check for conflicts
        conflicts = detector.find_conflicts(fact)
        if conflicts:
            print(f"  → Found {len(conflicts)} conflicting facts, handling supersession...")
            detector.handle_supersession(fact, conflicts)
        
        # Check for duplicates
        duplicates = detector.find_duplicates(fact)
        if duplicates:
            print(f"  → Found {len(duplicates)} duplicates, merging...")
            detector.handle_duplicates(fact, duplicates)
        
        detector.close()
        
        return fact_id
    
    def process_turn(self, session_id: str, content: str, speaker: str, 
                     event_id: int, timestamp: int) -> Dict[str, Any]:
        """
        Main entry point: process a conversation turn.
        
        Returns processing result with action taken.
        """
        context = {
            "session_id": session_id,
            "speaker": speaker,
            "event_id": event_id,
            "timestamp": timestamp
        }
        
        # Step 1: Value judgment
        assessment = self.assess_value(content, context)
        
        if not assessment["should_remember"]:
            return {
                "action": "ignore",
                "reason": assessment["reason"],
                "confidence": assessment["confidence"]
            }
        
        # Step 2: Ambiguity detection
        ambiguities = self.detect_ambiguity(content)
        
        if ambiguities:
            # Try to disambiguate via search
            search_results = self.search_memory(" ".join(content.split()[:10]))
            context["disambiguation_results"] = search_results
        
        # Step 3: Completeness check
        if not self.is_complete(content, ambiguities):
            buffer_id = self.buffer_memory(
                content, 
                session_id, 
                "incomplete" if not ambiguities else "ambiguous",
                {"ambiguities": ambiguities}
            )
            return {
                "action": "buffer",
                "buffer_id": buffer_id,
                "reason": "Incomplete or ambiguous",
                "ambiguities": ambiguities
            }
        
        # Step 4: Extract and store
        # For now, use simple extraction (can upgrade to LLM)
        # This is a placeholder - real extraction would parse content into structured facts
        
        # Example: If content is "Never write emojis in GitHub comments"
        # Extract: (subject="GitHub comments", predicate="never_write", object="emojis")
        
        # For this demo, we'll just note that extraction needs to be implemented
        return {
            "action": "ready_to_extract",
            "fact_type": assessment["fact_type"],
            "confidence": assessment["confidence"],
            "needs_llm_extraction": True
        }
    
    def close(self):
        self.conn.close()


def test_value_assessment():
    """Test the value assessment on sample content"""
    db_path = Path.home() / ".local/share/memory-system/data/memory.db"
    manager = ActiveMemoryManager(str(db_path))
    
    test_cases = [
        ("Never write emojis in GitHub comments", {"speaker": "user"}),
        ("I prefer Turkish Airlines", {"speaker": "user"}),
        ("My passport number is AB123456", {"speaker": "user"}),
        ("Fixed the Docker networking issue by adding host.docker.internal", {"speaker": "user"}),
        ("lol ok", {"speaker": "user"}),
        ("The weather is nice today", {"speaker": "user"}),
        ("Let me explain the architecture in detail. We have three services...", {"speaker": "user"}),
    ]
    
    print("=" * 80)
    print("Value Assessment Tests")
    print("=" * 80)
    
    for content, context in test_cases:
        assessment = manager.assess_value(content, context)
        print(f"\nContent: '{content[:60]}...'")
        print(f"  Should remember: {assessment['should_remember']}")
        print(f"  Reason: {assessment['reason']}")
        print(f"  Confidence: {assessment['confidence']:.2f}")
        print(f"  Fact type: {assessment['fact_type']}")
    
    manager.close()


if __name__ == "__main__":
    test_value_assessment()

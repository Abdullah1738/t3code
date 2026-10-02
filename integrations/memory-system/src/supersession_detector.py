#!/usr/bin/env python3
"""
Deterministic Supersession Detector (MemStrata-inspired)

Key insight from research: Cosine similarity AUROC 0.59 for contradiction detection (near chance).
Contradictions are MORE similar to originals than rephrasings.

Solution: Deterministic matching on (subject, predicate) → if object differs, it's supersession.
No threshold tuning, no similarity scoring. Structural detection only.
"""

import sqlite3
from dataclasses import dataclass
from typing import Optional, List, Tuple
from pathlib import Path


@dataclass
class Fact:
    id: int
    fact_type: str
    subject: str
    predicate: str
    object: str
    statement: str
    source_event_id: int
    extracted_at: int
    confidence: float
    supersedes_id: Optional[int]
    superseded_by_id: Optional[int]
    valid_from: int
    valid_until: Optional[int]
    is_active: int


class SupersessionDetector:
    """Deterministic supersession detection via (subject, predicate) matching"""
    
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
    
    def find_conflicts(self, fact: Fact) -> List[Fact]:
        """
        Find existing facts with same (subject, predicate) but different object.
        This is deterministic supersession - no similarity thresholds.
        """
        cursor = self.conn.cursor()
        cursor.execute("""
            SELECT * FROM semantic_facts
            WHERE subject = ?
              AND predicate = ?
              AND object != ?
              AND is_active = 1
              AND (valid_until IS NULL OR valid_until > ?)
            ORDER BY valid_from DESC
        """, (fact.subject, fact.predicate, fact.object, fact.valid_from))
        
        conflicts = []
        for row in cursor.fetchall():
            conflicts.append(Fact(
                id=row['id'],
                fact_type=row['fact_type'],
                subject=row['subject'],
                predicate=row['predicate'],
                object=row['object'],
                statement=row['statement'],
                source_event_id=row['source_event_id'],
                extracted_at=row['extracted_at'],
                confidence=row['confidence'],
                supersedes_id=row['supersedes_id'],
                superseded_by_id=row['superseded_by_id'],
                valid_from=row['valid_from'],
                valid_until=row['valid_until'],
                is_active=row['is_active']
            ))
        
        return conflicts
    
    def find_duplicates(self, fact: Fact) -> List[Fact]:
        """
        Find existing facts with same (subject, predicate, object).
        These are duplicates, not supersessions.
        """
        cursor = self.conn.cursor()
        cursor.execute("""
            SELECT * FROM semantic_facts
            WHERE subject = ?
              AND predicate = ?
              AND object = ?
              AND is_active = 1
              AND id != ?
            ORDER BY valid_from ASC
        """, (fact.subject, fact.predicate, fact.object, fact.id if fact.id else -1))
        
        duplicates = []
        for row in cursor.fetchall():
            duplicates.append(Fact(
                id=row['id'],
                fact_type=row['fact_type'],
                subject=row['subject'],
                predicate=row['predicate'],
                object=row['object'],
                statement=row['statement'],
                source_event_id=row['source_event_id'],
                extracted_at=row['extracted_at'],
                confidence=row['confidence'],
                supersedes_id=row['supersedes_id'],
                superseded_by_id=row['superseded_by_id'],
                valid_from=row['valid_from'],
                valid_until=row['valid_until'],
                is_active=row['is_active']
            ))
        
        return duplicates
    
    def handle_supersession(self, new_fact: Fact, conflicts: List[Fact]) -> None:
        """
        Deterministic supersession: retire old facts, activate new one.
        
        Rules:
        1. Set old_fact.valid_until = new_fact.valid_from
        2. Set old_fact.is_active = 0
        3. Set old_fact.superseded_by_id = new_fact.id
        4. Set new_fact.supersedes_id = old_fact.id
        5. Create 'supersede' evidence edge
        """
        cursor = self.conn.cursor()
        
        for old_fact in conflicts:
            # Retire old fact
            cursor.execute("""
                UPDATE semantic_facts
                SET valid_until = ?,
                    is_active = 0,
                    superseded_by_id = ?
                WHERE id = ?
            """, (new_fact.valid_from, new_fact.id, old_fact.id))
            
            # Create supersede edge
            cursor.execute("""
                INSERT OR IGNORE INTO evidence_edges 
                (source_fact_id, target_fact_id, edge_type, confidence, created_at, source_event_id)
                VALUES (?, ?, 'supersede', 1.0, ?, ?)
            """, (new_fact.id, old_fact.id, new_fact.valid_from, new_fact.source_event_id))
            
            print(f"  ✓ Superseded fact {old_fact.id}: '{old_fact.statement}'")
        
        # Update new fact to reference what it supersedes
        if conflicts:
            cursor.execute("""
                UPDATE semantic_facts
                SET supersedes_id = ?
                WHERE id = ?
            """, (conflicts[0].id, new_fact.id))  # Point to most recent conflict
        
        self.conn.commit()
    
    def handle_duplicates(self, keeper_fact: Fact, duplicates: List[Fact]) -> None:
        """
        Merge duplicates: keep earliest, mark others as inactive.
        """
        cursor = self.conn.cursor()
        
        for dup_fact in duplicates:
            # Deactivate duplicate
            cursor.execute("""
                UPDATE semantic_facts
                SET is_active = 0,
                    valid_until = ?
                WHERE id = ?
            """, (dup_fact.extracted_at, dup_fact.id))
            
            # Create 'related' edge (these are saying the same thing)
            cursor.execute("""
                INSERT OR IGNORE INTO evidence_edges 
                (source_fact_id, target_fact_id, edge_type, confidence, created_at, source_event_id)
                VALUES (?, ?, 'related', 1.0, ?, ?)
            """, (keeper_fact.id, dup_fact.id, dup_fact.extracted_at, dup_fact.source_event_id))
            
            print(f"  ✓ Merged duplicate fact {dup_fact.id}")
        
        self.conn.commit()
    
    def audit_existing_facts(self) -> dict:
        """
        Audit all existing facts for supersessions and duplicates.
        Returns stats about what was found and fixed.
        """
        cursor = self.conn.cursor()
        cursor.execute("""
            SELECT * FROM semantic_facts
            WHERE is_active = 1
            ORDER BY subject, predicate, valid_from ASC
        """)
        
        stats = {
            'total_active': 0,
            'duplicates_found': 0,
            'supersessions_found': 0,
            'facts_retired': 0
        }
        
        # Group by (subject, predicate)
        fact_groups = {}
        for row in cursor.fetchall():
            fact = Fact(
                id=row['id'],
                fact_type=row['fact_type'],
                subject=row['subject'],
                predicate=row['predicate'],
                object=row['object'],
                statement=row['statement'],
                source_event_id=row['source_event_id'],
                extracted_at=row['extracted_at'],
                confidence=row['confidence'],
                supersedes_id=row['supersedes_id'],
                superseded_by_id=row['superseded_by_id'],
                valid_from=row['valid_from'],
                valid_until=row['valid_until'],
                is_active=row['is_active']
            )
            stats['total_active'] += 1
            
            key = (fact.subject, fact.predicate)
            if key not in fact_groups:
                fact_groups[key] = []
            fact_groups[key].append(fact)
        
        print(f"\nAuditing {stats['total_active']} active facts...\n")
        
        # Process each group
        for (subject, predicate), facts in fact_groups.items():
            if len(facts) == 1:
                continue  # No conflicts or duplicates
            
            # Group by object value
            object_groups = {}
            for fact in facts:
                if fact.object not in object_groups:
                    object_groups[fact.object] = []
                object_groups[fact.object].append(fact)
            
            # Handle duplicates within each object group
            for obj_value, obj_facts in object_groups.items():
                if len(obj_facts) > 1:
                    print(f"Found {len(obj_facts)} duplicates: ({subject}, {predicate}, {obj_value})")
                    keeper = obj_facts[0]  # Keep earliest
                    duplicates = obj_facts[1:]
                    self.handle_duplicates(keeper, duplicates)
                    stats['duplicates_found'] += len(duplicates)
                    stats['facts_retired'] += len(duplicates)
            
            # Handle supersessions (multiple objects for same subject+predicate)
            if len(object_groups) > 1:
                print(f"Found supersession chain: ({subject}, {predicate})")
                # Sort by valid_from, keep only the latest
                all_facts = sorted(facts, key=lambda f: f.valid_from)
                latest = all_facts[-1]
                older = all_facts[:-1]
                
                print(f"  Latest: '{latest.statement}' (valid from {latest.valid_from})")
                
                # Only retire older facts if they're still active
                active_older = [f for f in older if f.is_active]
                if active_older:
                    self.handle_supersession(latest, active_older)
                    stats['supersessions_found'] += len(active_older)
                    stats['facts_retired'] += len(active_older)
        
        return stats
    
    def close(self):
        self.conn.close()


def main():
    db_path = Path.home() / ".local/share/memory-system/data/memory.db"
    
    print("=" * 80)
    print("Deterministic Supersession Detector")
    print("=" * 80)
    
    detector = SupersessionDetector(str(db_path))
    
    try:
        stats = detector.audit_existing_facts()
        
        print("\n" + "=" * 80)
        print("Audit Complete")
        print("=" * 80)
        print(f"Total active facts audited: {stats['total_active']}")
        print(f"Duplicates found and merged: {stats['duplicates_found']}")
        print(f"Supersession chains detected: {stats['supersessions_found']}")
        print(f"Facts retired: {stats['facts_retired']}")
        print(f"Facts remaining active: {stats['total_active'] - stats['facts_retired']}")
        
    finally:
        detector.close()


if __name__ == "__main__":
    main()

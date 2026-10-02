# Agent Memory Architecture: Quality-First Design
**Research Date:** September 22, 2026  
**Cost Context:** glm-5.3-flash @ $0.0015 in / $0.005 out (cost is not a constraint)

---

## Executive Summary

After deep research into 2025-2026 SOTA systems, **the winning architecture is fundamentally different from what cost-optimization would suggest**. The critical insight: **benchmark leaderboards are misleading** — the same system scores 52%-92% on LoCoMo depending on judge prompts, and full-context baselines beat dedicated memory systems by 30+ points on factual recall.

**What actually discriminates quality:**
1. **Temporal validity** (serving current facts, not stale ones)
2. **Conflict resolution** (handling contradictions and supersession)
3. **Active memory management** (deciding what to remember, not just extracting everything)
4. **Personal knowledge compilation** (aggregating preferences, not just retrieving snippets)

**The architecture below prioritizes these hard problems** that separate production-grade memory from toy systems.

---

## Part 1: The Benchmark Deception

### What the Leaderboards Hide

**Finding 1: Judge Variance Dominates Signal**
- Mem0 reported: 92.5% on LoCoMo
- Zep's rebuttal: same system, different judge → 66.9%
- Zep's self-correction: 84% → 58.44% after fixing evaluation

**Conclusion:** Headline numbers are measuring judge prompts, not memory quality.

**Finding 2: Full-Context Beats Memory Systems**
- Long-context GPT-4.1 beats best memory system by **35.2 points on LoCoMo**, **33.4 on LongMemEval**
- Why: LoCoMo conversations are ~16-26K tokens (fit in context)
- Memory systems lose accuracy through lossy compression

**Conclusion:** On short conversations, memory is the wrong tool. Accuracy is not why you build memory.

**Finding 3: The Real Discriminators**
Per-category breakdown reveals where systems actually differ:

| Category | What It Tests | Typical Scores |
|----------|--------------|----------------|
| Single-hop factual | "What did I say about X?" | 80-95% (everyone wins) |
| **Temporal reasoning** | "What was true then vs now?" | **31-79%** (huge spread) |
| **Knowledge updates** | "I changed my mind, what's current?" | **15-60%** (RAG fails structurally) |
| **Conflict resolution** | Multi-hop contradictions | **0-28%** (all systems fail) |
| Multi-session | Cross-session inference | 21-87% |
| Abstention | "I don't know" when stale | Under-weighted everywhere |

**Conclusion:** Build for temporal reasoning and conflict resolution. Factual recall is table stakes.

---

## Part 2: The Temporal Validity Crisis

### The Core Failure Mode

**MemStrata (June 2026) ran controlled experiments:**
- Codebase memory with function renames, config changes, dependency bumps
- RAG accuracy on evolving knowledge: **0.20-0.47**
- RAG stale-fact error rate (forced to answer): **15-40%**

**Why RAG fails structurally:**
```
Database has:
  - "API endpoint is /v1/users" (6 months ago)
  - "API endpoint is /v2/users" (current)

Embedding similarity:
  - Original vs contradiction: 0.89 (high!)
  - Original vs rephrase: 0.84 (lower!)

RAG retrieves both, can't tell which is current.
Agent serves stale value 40% of the time.
```

**Key insight:** Contradictions are MORE similar to originals than rephrasings are (value-flip is minimal edit distance).

### The Solution: Deterministic Supersession

MemStrata's bi-temporal ledger:
```sql
CREATE TABLE facts (
    id INTEGER PRIMARY KEY,
    subject TEXT,
    relation TEXT,
    object TEXT,
    valid_from INTEGER,  -- When fact became true
    valid_to INTEGER,    -- When superseded (NULL = current)
    recorded_at INTEGER, -- When we learned it
    superseded_by INTEGER REFERENCES facts(id)
);

-- Deterministic rule: If new fact contradicts old fact (same subject+relation, different object)
-- → Retire old fact, set valid_to = new_fact.valid_from
```

**Results:**
- Static knowledge: 1.00 accuracy (ties RAG)
- Evolving knowledge: 0.95-1.00 accuracy (RAG: 0.20-0.47)
- Stale-fact error rate: **~0%** (RAG: 15-40%)
- Latency: ~2.1s (embedding only, no LLM on read path)

**Why it works:** Supersession is structural (subject, relation, object matching), not similarity-based. No threshold to tune.

---

## Part 3: Active vs Passive Memory Management

### The Passive Extraction Trap

Most systems (Mem0, Zep, MemGPT) treat memory as passive transcription:
```
Input: "I prefer concise code. This project needs Python 3.9 compatibility."
Action: Extract → Store both as facts
Problem: Both stored together, retrieved together, can't be independently reused
```

### MemReader's Active Management (June 2026)

**Reframes memory as state maintenance**, not extraction. At each turn, agent asks:
1. **Value judgment:** Worth memorizing? (decision/preference/knowledge vs chatter)
2. **Ambiguity detection:** Pronouns, references needing disambiguation?
3. **Completeness check:** Can store now, or buffer for later clarification?

**Four tools (not just "store"):**
- `add_memory`: Write atomic fact
- `search_memory`: Disambiguate reference
- `buffer_memory`: Hold incomplete info
- `ignore_memory`: Discard low-value chatter

**Example:**
```
User: "Update the config like we discussed."
Passive system: Extracts vague fact "update config"
MemReader: 
  1. Think: Ambiguous reference, incomplete
  2. Action: search_memory("config discussion")
  3. Retrieve: "Config discussion: switch timeout from 30s to 60s"
  4. Action: add_memory("Config timeout updated to 60s")
```

**Key results:**
- LoCoMo: SOTA performance
- LongMemEval: Beats GPT-4o-mini baselines
- **Knowledge updating & temporal reasoning:** Biggest gains (the hard categories)

---

## Part 4: Personal Knowledge Compilation

### The Bag-of-Facts Problem

Traditional retrieval:
```
Query: "How many international trips did I take last year?"
Memory: ["Trip to Paris in March", "Visited Tokyo in July", ...]
Agent: Retrieves 5 snippets, tries to count in prompt
Accuracy: 6-43% (retrieval-based systems)
```

### User as Code (UaC) - Executable Memory (June 2026)

**Core idea:** Memory is typed Python code, not text snippets.

```python
@dataclass
class UserProfile:
    name: str
    passport_number: str
    frequent_flyer: dict[str, str]  # airline → number
    travel_history: list[Trip]
    dietary_restrictions: list[str]
    
    def international_trips_in_year(self, year: int) -> int:
        return len([t for t in self.travel_history 
                   if t.year == year and t.country != "USA"])
    
    def alert_drug_allergy_conflict(self, new_drug: str) -> Optional[str]:
        """Unsolicited safety-critical check"""
        if new_drug in KNOWN_INTERACTIONS:
            conflicting = [a for a in self.allergies 
                          if a in KNOWN_INTERACTIONS[new_drug]]
            if conflicting:
                return f"⚠️ {new_drug} conflicts with allergy: {conflicting}"
        return None
```

**How it works:**
- Append-only log (never discard raw events)
- Periodic checkpoint into typed code
- Queries run as computation over state

**Results:**
- Factual recall: 78.8% (ties RAG and full-context)
- **Aggregate queries: 99%** (vs 6-43% for retrieval)
- **Proactive alerts:** Safety-critical checks (drug-allergy) fire deterministically when state changes

**Why it wins:** Representation matches the problem. "How many trips?" is a one-line function, not a retrieval+counting task.

---

## Part 5: Preference Evolution & Supersession

### AdaMem: Adaptive Memory Policies (Sept 2026)

**Problem:** Uniform extraction applies one notion of "important" everywhere.
- Manager: final decisions matter
- Partner: emotional reactions matter
- Colleague: technical conclusions matter

**Solution:** Per-persona memory policies (natural language rules).

```
Persona: Work Manager
Memory Policy: "Remember final decisions and their rationales. 
                Discard exploratory ideas unless they led to decisions.
                Track project deadlines and blockers."

Persona: Family
Memory Policy: "Remember plans, preferences, and emotional moments.
                Track ongoing commitments and future events."
```

**How it works:**
1. User gives feedback: "Don't remember casual work chat, only decisions"
2. Policy updater revises policy text
3. Extractor follows policy on future conversations

**Results (AdaMem-Bench):**
- QA accuracy: 80.0% → 84.35% (+4.35 points)
- Memory size: -9.27% (smaller, better store)
- Key recall: 88.9% → 93.6% (preserves important facts)
- Noise rejection: 10.9% → 20.1% (filters distractors)

**Insight:** Quality comes from **selective writing**, not exhaustive extraction.

---

## Part 6: Multi-Graph Architecture

### Why Single-View Memory Fails

**MAGMA (ACL 2026) problem statement:**
```
Query: "When did Melanie hike?"
Single semantic index: Retrieves ["Melanie plays violin", "Melanie's son", "Yesterday we hiked"]
Problem: "Yesterday" is underweighted vs entity matches
```

**Solution:** Orthogonal graph views
1. **Semantic graph:** Topic/concept similarity
2. **Temporal graph:** Chronological order, normalized timestamps
3. **Entity graph:** Person/place references
4. **Causal graph:** Cause → effect relationships

**Query-adaptive traversal:**
- "What instruments does Melanie play?" → Entity + Semantic views
- "How many children does Melanie have?" → Entity neighborhood
- "When did she hike?" → **Temporal view** (prioritize time expressions)

**Results:**
- LoCoMo: 70% (best memory system, beats full-context)
- Temporal reasoning: 65% (biggest discriminator)
- Adversarial: 74.2% (resists semantically similar distractors)

---

## Part 7: The Four-Network Pattern (Production Systems)

### HINDSIGHT (ACL 2026 Demo)

**Architecture:** Four parallel retrieval channels
1. **Vector search** (pgvector HNSW)
2. **BM25** (PostgreSQL GIN index)
3. **Graph traversal** (BFS with activation decay, 2-3 hops)
4. **Temporal retrieval** (rule-based date parser + T5 fallback)

**Fusion:** RRF (Reciprocal Rank Fusion) → Cross-encoder reranking

**Results:**
- LongMemEval: **91.4%** (with Gemini-3 Pro, highest published)
- LoCoMo: 83.2% (20B model beats full-context GPT-4o)
- Multi-session: 21.1% → 79.7% (biggest gain)
- Temporal reasoning: 31.6% → 79.7%

**Why it works:**
- Token budget prevents context overflow (bounded retrieval)
- Four channels cover complementary failure modes
- No LLM on read path → 200ms retrieval latency

**Production features:**
- Single PostgreSQL database (no vector store, no Elasticsearch)
- Schema-per-tenant isolation
- MCP server for AI coding assistants
- Webhook subscriptions for event-driven pipelines

---

## Part 8: Conflict Resolution & Validity Scoring

### MemConflict Framework (May 2026)

**Three conflict types:**

1. **Dynamic conflicts** (temporal validity)
   - Earlier state vs later state
   - "I prefer tea" (3 months ago) → "I prefer coffee" (now)

2. **Static conflicts** (factual correctness)
   - Contradictory mentions without true state change
   - "Meeting at 3pm" vs "Meeting at 4pm" (one is wrong)

3. **Conditional conflicts** (contextual applicability)
   - "I'm vegetarian at home, not when traveling"
   - Query context determines which applies

**Validity scoring (PGMem-style):**
```
For each candidate fact:
  support_paths = count(⊕ edges leading to this fact)
  contradict_paths = count(⊖ edges leading to this fact)
  validity_score = support_paths / (support_paths + contradict_paths + 1)
  
Final score = relevance × validity
```

**Why this matters:** Retrieved facts must be **jointly valid**, not individually relevant.

---

## Part 9: The Winning Architecture for Your System

### Core Principles (Quality-First)

1. **Temporal validity is non-negotiable** → Deterministic supersession
2. **Active memory management** → Decide what to remember
3. **Executable knowledge** → Typed facts, not text bags
4. **Multi-view retrieval** → Graph + semantic + temporal + entity
5. **Conflict-aware ranking** → Validity scoring, not just relevance

### Recommended Stack

#### Layer 1: Storage (Bi-Temporal Facts)

```sql
-- Raw event log (never delete)
CREATE TABLE event_log (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    role TEXT CHECK(role IN ('user', 'assistant', 'system')),
    content TEXT,
    tool_calls JSONB,
    embedding vector(1024)  -- for semantic search
);

-- Structured facts with temporal validity
CREATE TABLE facts (
    id INTEGER PRIMARY KEY,
    subject TEXT NOT NULL,
    relation TEXT NOT NULL,
    object TEXT,
    fact_type TEXT CHECK(fact_type IN ('decision', 'preference', 'knowledge', 'constraint')),
    
    -- Bi-temporal tracking
    valid_from INTEGER NOT NULL,    -- When fact became true
    valid_to INTEGER,                -- When superseded (NULL = current)
    recorded_at INTEGER NOT NULL,    -- When we learned it
    
    -- Provenance
    source_event_ids INTEGER[] NOT NULL,
    confidence REAL DEFAULT 1.0,
    
    -- Supersession tracking
    superseded_by INTEGER REFERENCES facts(id),
    supersedes INTEGER REFERENCES facts(id),
    
    -- Embeddings for semantic search
    embedding vector(1024),
    
    UNIQUE(subject, relation, valid_from)  -- Prevent duplicate facts at same time
);

-- Evidence edges (PGMem-style)
CREATE TABLE evidence_edges (
    source_fact_id INTEGER REFERENCES facts(id),
    target_fact_id INTEGER REFERENCES facts(id),
    edge_type TEXT CHECK(edge_type IN ('support', 'contradict', 'supersede', 'related')),
    confidence REAL DEFAULT 1.0,
    PRIMARY KEY (source_fact_id, target_fact_id, edge_type)
);

-- Entity graph
CREATE TABLE entities (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    entity_type TEXT,  -- person, place, project, concept
    attributes JSONB,
    embedding vector(1024)
);

CREATE TABLE entity_mentions (
    entity_id INTEGER REFERENCES entities(id),
    fact_id INTEGER REFERENCES facts(id),
    PRIMARY KEY (entity_id, fact_id)
);

-- Temporal graph (implicit via valid_from/valid_to)
-- Causal graph
CREATE TABLE causal_edges (
    cause_fact_id INTEGER REFERENCES facts(id),
    effect_fact_id INTEGER REFERENCES facts(id),
    PRIMARY KEY (cause_fact_id, effect_fact_id)
);

-- Compiled user profile (User as Code pattern)
CREATE TABLE user_profile (
    user_id TEXT PRIMARY KEY,
    profile_code TEXT,  -- Python code representing user state
    last_compiled INTEGER,
    version INTEGER DEFAULT 1
);
```

#### Layer 2: Active Memory Manager (MemReader-inspired)

```python
class MemoryManager:
    """Active memory management with value judgment"""
    
    def process_turn(self, session_id: str, content: str, timestamp: int):
        """Main entry point for new interactions"""
        
        # 1. Value judgment
        value_assessment = self.assess_value(content)
        if value_assessment.type == "ignore":
            return  # Low-value chatter
        
        # 2. Ambiguity detection
        ambiguous_refs = self.detect_ambiguity(content)
        if ambiguous_refs:
            # Search historical context
            disambiguated = self.search_memory(ambiguous_refs)
            content = self.resolve_references(content, disambiguated)
        
        # 3. Completeness check
        if not self.is_complete(content):
            self.buffer_memory(content, session_id)
            return  # Wait for clarification
        
        # 4. Extract structured facts
        facts = self.extract_facts(content, timestamp)
        
        # 5. Supersession detection
        for fact in facts:
            conflicts = self.find_conflicts(fact)
            if conflicts:
                self.handle_supersession(fact, conflicts, timestamp)
            else:
                self.store_fact(fact)
    
    def handle_supersession(self, new_fact: Fact, conflicts: list[Fact], timestamp: int):
        """Deterministic supersession (MemStrata-style)"""
        for old_fact in conflicts:
            if self.is_contradiction(new_fact, old_fact):
                # Same subject+relation, different object → supersession
                old_fact.valid_to = timestamp
                old_fact.superseded_by = new_fact.id
                
                # Create supersede edge
                self.create_edge(new_fact, old_fact, "supersede")
        
        new_fact.valid_from = timestamp
        new_fact.supersedes = [c.id for c in conflicts]
        self.store_fact(new_fact)
```

#### Layer 3: Hybrid Retrieval (Four-Network)

```python
class HybridRetriever:
    """HINDSIGHT-style four-network retrieval"""
    
    def retrieve(self, query: str, timestamp: int, token_budget: int) -> list[Fact]:
        """Parallel retrieval + RRF fusion + validity filtering"""
        
        # Run four channels in parallel
        vector_results = self.vector_search(query, top_k=20)
        bm25_results = self.bm25_search(query, top_k=20)
        graph_results = self.graph_traversal(query, max_hops=3, top_k=20)
        temporal_results = self.temporal_search(query, timestamp, top_k=20)
        
        # RRF fusion
        fused = self.reciprocal_rank_fusion([
            vector_results,
            bm25_results,
            graph_results,
            temporal_results
        ])
        
        # Temporal validity filter
        valid_facts = [f for f in fused if self.is_temporally_valid(f, timestamp)]
        
        # Validity scoring (conflict-aware)
        for fact in valid_facts:
            fact.validity_score = self.compute_validity(fact)
        
        # Rerank by (relevance × validity)
        ranked = sorted(valid_facts, key=lambda f: f.relevance * f.validity_score, reverse=True)
        
        # Pack within token budget
        return self.pack_within_budget(ranked, token_budget)
    
    def is_temporally_valid(self, fact: Fact, query_time: int) -> bool:
        """Check if fact is valid at query time"""
        return fact.valid_from <= query_time and (fact.valid_to is None or query_time < fact.valid_to)
    
    def compute_validity(self, fact: Fact) -> float:
        """Validity scoring with evidence edges"""
        support = self.count_edges(fact, "support")
        contradict = self.count_edges(fact, "contradict")
        return support / (support + contradict + 1)
```

#### Layer 4: User Profile Compiler (User as Code)

```python
class ProfileCompiler:
    """Compile bag-of-facts into executable code"""
    
    def compile_profile(self, user_id: str) -> str:
        """Generate typed Python code from facts"""
        
        facts = self.get_current_facts(user_id)
        
        # Group facts by entity/topic
        personal_info = [f for f in facts if f.fact_type == "knowledge" and f.subject == "user"]
        preferences = [f for f in facts if f.fact_type == "preference"]
        decisions = [f for f in facts if f.fact_type == "decision"]
        
        code = f'''
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

@dataclass
class UserProfile:
    # Personal information
    name: str = "{self.extract_value(personal_info, 'name')}"
    passport_number: str = "{self.extract_value(personal_info, 'passport')}"
    
    # Travel preferences
    preferred_airline: str = "{self.extract_value(preferences, 'airline')}"
    frequent_flyer_number: str = "{self.extract_value(personal_info, 'ff_number')}"
    
    # Dietary
    dietary_restrictions: list[str] = {self.extract_list(preferences, 'dietary')}
    
    # Work preferences
    code_style: str = "{self.extract_value(preferences, 'code_style')}"
    never_use_emojis_in: list[str] = {self.extract_list(decisions, 'emoji_policy')}
    
    # Computed properties
    def book_flight_preferences(self) -> dict:
        return {{
            "airline": self.preferred_airline,
            "ff_number": self.frequent_flyer_number,
            "meal": "vegetarian" if "vegetarian" in self.dietary_restrictions else "standard"
        }}
    
    def check_allergy_conflict(self, drug: str) -> Optional[str]:
        """Safety-critical proactive check"""
        if drug in DRUG_INTERACTIONS:
            conflicts = [d for d in self.dietary_restrictions 
                        if d in DRUG_INTERACTIONS[drug]]
            if conflicts:
                return f"⚠️ ALERT: {{drug}} conflicts with {{conflicts}}"
        return None
'''
        return code
```

---

## Part 10: Implementation Roadmap (Quality-First)

### Phase 1: Foundation (2-3 days)
**Goal:** Bi-temporal storage with deterministic supersession

- [ ] Implement bi-temporal facts table with valid_from/valid_to
- [ ] Build deterministic supersession detector (subject+relation matching)
- [ ] Migrate existing 8M events into event_log (preserve everything)
- [ ] Extract initial facts from high-value sessions (100+ events, ~5K sessions)
- [ ] **Quality gate:** Manual audit of 100 supersession cases (should be 100% correct)

**Expected outcome:** Zero stale-fact errors (vs 15-40% baseline)

### Phase 2: Active Memory Management (3-4 days)
**Goal:** MemReader-style value judgment and selective writing

- [ ] Build value assessment classifier (decision/preference/knowledge/chatter)
- [ ] Implement ambiguity detector (pronouns, references)
- [ ] Build completeness checker + buffer mechanism
- [ ] Train on 1,000 hand-labeled examples (high-value sessions)
- [ ] **Quality gate:** 90%+ precision on "should remember" decisions

**Expected outcome:** 10-20% reduction in stored facts, higher quality store

### Phase 3: Multi-View Retrieval (3-4 days)
**Goal:** Four-network retrieval with validity scoring

- [ ] Implement vector search (pgvector with text-embedding-3-large)
- [ ] Implement BM25 search (PostgreSQL GIN indexes)
- [ ] Build entity graph + traversal (BFS with activation decay)
- [ ] Build temporal search (normalize relative dates)
- [ ] Implement RRF fusion + cross-encoder reranking
- [ ] Add validity scoring (evidence edges)
- [ ] **Quality gate:** Temporal reasoning accuracy >75% (vs <50% baseline)

**Expected outcome:** Match or beat HINDSIGHT benchmarks

### Phase 4: User Profile Compiler (2-3 days)
**Goal:** User as Code executable memory

- [ ] Build fact→code compiler for personal info
- [ ] Generate typed dataclass with properties
- [ ] Add aggregate query methods (count, filter, group)
- [ ] Add proactive safety checks (drug-allergy conflicts)
- [ ] **Quality gate:** 95%+ accuracy on aggregate queries (vs 6-43% retrieval baseline)

**Expected outcome:** Passport/airline/preferences instantly available, no retrieval needed

### Phase 5: Continuous Import & Maintenance (2 days)
**Goal:** Stay up-to-date with new sessions

- [ ] Nightly import of new OpenCode sessions
- [ ] Incremental fact extraction (process only new events)
- [ ] Reconsolidation: strengthen co-retrieved facts (REALM-style)
- [ ] Periodic profile recompilation (weekly)
- [ ] **Quality gate:** <24 hour lag from session end to memory availability

**Expected outcome:** Never need to manually import again

### Phase 6: MCP Server & Agent Integration (2-3 days)
**Goal:** Make memory accessible to agents

- [ ] Build MCP server with `recall()` and `store()` APIs
- [ ] Implement token budget controls
- [ ] Add streaming for long retrievals
- [ ] Expose profile.py for direct code execution
- [ ] **Quality gate:** Agent can answer "why did you X" from memory in <2s

**Expected outcome:** Native decision memory works in live sessions

---

## Part 11: Quality Metrics (How to Measure Success)

### Tier 1: Correctness
- **Temporal validity:** 0% stale-fact error rate (baseline: 15-40%)
- **Factual accuracy:** 95%+ on static knowledge (match RAG)
- **Aggregate queries:** 95%+ accuracy (baseline: 6-43%)

### Tier 2: Discriminating Tasks
- **Temporal reasoning:** 75%+ accuracy (baseline: 31%)
- **Knowledge updates:** 85%+ accuracy (baseline: 15-60%)
- **Conflict resolution (single-hop):** 70%+ (baseline: 60%)
- **Conflict resolution (multi-hop):** 40%+ (baseline: 0-7%)

### Tier 3: Production Metrics
- **Retrieval latency:** <2s (no LLM on read path)
- **Memory size efficiency:** 10-20% reduction vs passive extraction
- **Key fact recall:** 90%+ (important facts preserved)
- **Noise rejection:** 20%+ (distractors filtered)

### Tier 4: User Experience
- **Decision memory:** "Why did you X?" answered from memory, not guessed
- **Preference consistency:** Never repeat warned behaviors (emoji policy)
- **Context pickup:** New session recalls previous project context automatically
- **Personal knowledge:** Booking flow gets passport/airline without asking

---

## Part 12: What We're NOT Building (Anti-Goals)

1. **❌ Eager consolidation of all 8M events**
   - Research shows 87% cost savings with recurrence-based, but quality isn't better
   - We'll consolidate high-value sessions (100+ events), leave rest in raw log

2. **❌ Similarity-based supersession**
   - MemStrata proved cosine similarity can't detect contradictions (AUROC 0.59)
   - We use deterministic (subject, relation) matching only

3. **❌ Single-view semantic memory**
   - Multi-graph outperforms by 10-20 points on temporal reasoning
   - We build four orthogonal views from day 1

4. **❌ Query-time LLM reranking**
   - 16-18s latency, doesn't improve quality enough to justify cost
   - We use cross-encoder (200ms) + validity scoring instead

5. **❌ Bag-of-facts for personal knowledge**
   - User as Code: 99% vs 6-43% on aggregate queries
   - We compile profile code, don't retrieve snippets

6. **❌ Chasing LoCoMo/LongMemEval leaderboards**
   - Numbers are meaningless (judge variance dominates)
   - We optimize for temporal reasoning, knowledge updates, conflict resolution

---

## Part 13: Key Research Citations

1. **MemStrata** (June 2026) - Temporal validity, deterministic supersession, bi-temporal ledger
2. **MemReader** (June 2026) - Active memory management, value judgment, completeness checking
3. **User as Code** (June 2026) - Executable memory, typed state, aggregate queries
4. **HINDSIGHT** (ACL 2026) - Four-network retrieval, production deployment, 91.4% LongMemEval
5. **MAGMA** (ACL 2026) - Multi-graph architecture, query-adaptive traversal
6. **AdaMem** (Sept 2026) - Adaptive memory policies, selective writing, 9.27% size reduction
7. **MemConflict** (May 2026) - Conflict taxonomy, validity scoring
8. **LoCoMo-Plus** (ACL 2026) - Cognitive vs factual memory, evaluation bias analysis
9. **MemoryAgentBench** (ICLR 2026) - RAG limitations, conflict resolution failure modes
10. **REALM** (Sept 2026) - Reconsolidation, co-retrieval strengthening

---

## Next Steps

1. **Review this document with Abdullah**
2. **Get approval on architecture direction**
3. **Begin Phase 1: Bi-temporal storage + deterministic supersession**

The critical insight: **Quality comes from structural solutions** (deterministic supersession, multi-view retrieval, typed compilation), **not from tuning similarity thresholds or throwing more LLM calls at the problem**.

Cost is not a constraint, so we build the right architecture from the start.

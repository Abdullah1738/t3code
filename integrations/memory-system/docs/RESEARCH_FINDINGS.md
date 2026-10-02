# State-of-the-Art Agent Memory Systems Research (2025-2026)

**Research Date:** September 22, 2026  
**Purpose:** Inform architectural decisions for Abdullah's unified memory system

## Executive Summary

Recent research (2025-2026) has converged on several key insights:

1. **Three-tier architecture** (subconscious/episodic/semantic) is the dominant paradigm
2. **Recurrence-based consolidation** drastically reduces token costs (87% reduction) while maintaining accuracy
3. **Graph-based memory** with typed edges enables temporal reasoning and supersession
4. **Hybrid retrieval** (semantic + lexical + graph traversal) outperforms pure vector similarity
5. **Active maintenance** through reconsolidation and validity scoring is critical for long-term accuracy

## Key Papers Analyzed

### 1. RecMem (May 2026) - **Primary Architecture Reference**
**Citation:** Dai et al., "RecMem: Recurrence-based Memory Consolidation for Efficient and Effective Long-Running LLM Agents"

**Core Innovation:** Recurrence-based consolidation instead of eager extraction

**Architecture:**
- **Subconscious layer:** Raw interactions stored with lightweight embeddings
- **Episodic layer:** Event-level narratives with temporal grounding
- **Semantic layer:** Atomic facts extracted through "semantic refinement"

**Key Mechanism:**
```
For incoming interaction i:
1. Store in subconscious with embedding v_i
2. Find similar interactions (cosine similarity > θ_sim)
3. If |similar_set| ≥ θ_count:
   a. Consolidate cluster into episodic memory (merge-first strategy)
   b. Extract semantic facts via refinement (detail recovery + fact maintenance)
4. Otherwise: leave in subconscious buffer
```

**Results:** 87% token cost reduction vs. eager systems while exceeding accuracy

**Why This Matters for Us:**
- We have 8M events backfilled—eager extraction would cost $10K+
- Recurrence detection identifies what's actually worth consolidating
- Three-tier retrieval prevents information loss from over-abstraction

---

### 2. PGMem (August 2026) - **Graph Structure Reference**
**Citation:** "Tightly Coupled Persona–Memory Graph for Lifelong Personalized Agents"

**Core Innovation:** Heterogeneous graph with evidence-typed edges

**Node Types:**
- **Event level:** Context (raw turns), Episode (summaries)
- **Persona level:** State (transient signals), Trait (stable dispositions)

**Edge Types:**
- **Source edges:** Provenance (Context → Episode → Trait)
- **Evidence edges:** 
  - ⊕ Support
  - ⊖ Contradiction
  - ↝ Temporal shift (supersession)
  - ∅ Irrelevant

**Retrieval Strategy:**
1. Seed retrieval (semantic + lexical, top-k per type)
2. Evidence-guided expansion (traverse ⊕/⊖/↝ edges)
3. Validity scoring (support vs. contradiction paths)

**Why This Matters for Us:**
- **Supersession is explicit** through ↝ edges (solves "3 months ago → changed 3 weeks ago")
- **Contradictions are tracked** (prevents stale facts from poisoning responses)
- **Persona-memory coupling** (user preferences linked to supporting evidence)

---

### 3. SYNAPSE (ACL 2026) - **Retrieval Reference**
**Citation:** Liu et al., "SYNAPSE: Synergistic Associative Processing & Semantic Encoding"

**Core Innovation:** Spreading activation instead of static k-NN

**Mechanism:**
- Graph-based memory with dynamic relevance through spreading activation
- Lateral inhibition filters interference
- Temporal decay naturally ages out stale content
- Triple Hybrid Retrieval: embeddings + graph traversal + activation

**Why This Matters for Us:**
- Solves "contextual tunneling" (k-NN missing multi-hop connections)
- Spreading activation naturally finds related decisions without exact keyword match

---

### 4. REALM (September 2026) - **Active Maintenance Reference**
**Citation:** Song et al., "Retrieval-Driven Memory Reconsolidation for Long-Term LLM Agents"

**Core Innovation:** Memory evolves based on retrieval feedback

**Mechanism:**
- Heterogeneous cognitive graph (like PGMem)
- Adaptive graph-search atoms composed per query
- **Reconsolidation:** Retrieved memories are reorganized based on usage patterns
- 7.17-point improvement on LoCoMo benchmark

**Why This Matters for Us:**
- Memory isn't write-once—it evolves as the agent uses it
- Related units cluster together over time through reconsolidation

---

### 5. MemCon (July 2026) - **Adaptive Control Reference**
**Citation:** Jiang et al., "Memory as a Controlled Process"

**Core Innovation:** Learned memory controller (when to retrieve, what to retrieve)

**Operations:** Retrieve, PlanInject, Re-Retrieve, Consolidate, Forget, NoOp

**Why This Matters for Us:**
- Not all queries need memory retrieval (early sessions, simple tasks)
- Plan reuse for recurring goal types
- Stuck detection triggers alternative queries

---

### 6. TrustMem (June 2026) - **Quality Control Reference**
**Citation:** Yang et al., "Learning Trustworthy Memory Consolidation"

**Core Innovation:** Memory Transition Verifier evaluates updates

**Verification Dimensions:**
- **Coverage:** Important info preserved from input
- **Preservation:** Valid prior memory maintained
- **Faithfulness:** New content supported by evidence

**Why This Matters for Us:**
- Prevents hallucinated facts from entering memory
- 40% reduction in omission, 79% in corruption, 50% in hallucination

---

## Architectural Recommendations

### Phase 1: Foundation (Current State ✓)
**Status:** COMPLETE (8M events, 34K sessions, 60GB database)

**What we have:**
```sql
episodic_events       -- Raw interactions (subconscious equivalent)
semantic_facts        -- Extracted facts (to be populated)
entity_graph          -- Sessions and relationships
```

**Gap:** Our `episodic_events` is actually the subconscious layer. We need a true episodic layer.

---

### Phase 2: Three-Tier Architecture (RecMem-inspired)

#### 2.1 Rename/Reorganize Layers
```sql
-- Layer 1: Subconscious (keep raw events)
CREATE TABLE subconscious_events (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    role TEXT CHECK(role IN ('user', 'assistant', 'system')),
    content TEXT,
    embedding BLOB,  -- Add lightweight embeddings
    consolidated BOOLEAN DEFAULT 0,  -- Track if consolidated
    UNIQUE(session_id, timestamp, role)
);

-- Layer 2: Episodic (temporal narratives)
CREATE TABLE episodic_memory (
    id INTEGER PRIMARY KEY,
    episode_summary TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    event_ids TEXT,  -- JSON array of subconscious_events.id
    embedding BLOB,
    created_at INTEGER DEFAULT (unixepoch()),
    last_merged INTEGER  -- Track merge operations
);

-- Layer 3: Semantic (atomic facts)
CREATE TABLE semantic_memory (
    id INTEGER PRIMARY KEY,
    fact TEXT NOT NULL,
    fact_type TEXT,  -- decision, preference, knowledge, constraint
    episode_id INTEGER REFERENCES episodic_memory(id),
    confidence REAL DEFAULT 1.0,
    created_at INTEGER DEFAULT (unixepoch()),
    superseded_by INTEGER REFERENCES semantic_memory(id),  -- Supersession tracking
    validity TEXT DEFAULT 'valid' CHECK(validity IN ('valid', 'superseded', 'contradicted'))
);
```

#### 2.2 Recurrence-Based Consolidation Strategy

**Backfill (one-time):**
- Process 34K sessions chronologically
- For each session with 10+ events:
  1. Check if theme recurs (cosine similarity > 0.85 to existing episodes)
  2. If recurrence ≥ 3: consolidate into episode + extract facts
  3. Otherwise: leave in subconscious

**Ongoing (real-time):**
- New OpenCode sessions imported nightly
- Consolidation triggered by recurrence threshold
- Cost: ~$0.01/session (only for recurring themes)

#### 2.3 Semantic Refinement (RecMem §3.4)

After episodic consolidation:
1. **Detail Recovery:** Extract entities/specifics omitted by summary
2. **Fact Maintenance:** Deduplicate, update evolving preferences

Example:
```
Episode: "User configured Crpko dev environment"
Semantic facts extracted:
- decision: "Use glm-5.3-flash for background workers, not Ollama"
- preference: "Never write emojis in GitHub comments"
- knowledge: "surplus API key location: ~/.config/opencode/surplus-token"
```

---

### Phase 3: Graph Structure (PGMem-inspired)

#### 3.1 Add Evidence Edges
```sql
CREATE TABLE memory_edges (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL,
    source_type TEXT NOT NULL,  -- 'event', 'episode', 'semantic'
    target_id INTEGER NOT NULL,
    target_type TEXT NOT NULL,
    edge_type TEXT NOT NULL CHECK(edge_type IN (
        'source',        -- Provenance
        'support',       -- Evidence ⊕
        'contradict',    -- Evidence ⊖
        'supersede',     -- Temporal shift ↝
        'related'        -- Semantic similarity
    )),
    confidence REAL DEFAULT 1.0,
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_edges_source ON memory_edges(source_id, source_type);
CREATE INDEX idx_edges_target ON memory_edges(target_id, target_type);
```

#### 3.2 Supersession Mechanism

When extracting new fact F_new that conflicts with existing F_old:
1. Detect contradiction (LLM classifier or embedding distance)
2. If F_new is newer and supported by recent evidence:
   ```sql
   UPDATE semantic_memory 
   SET validity='superseded', superseded_by=F_new.id 
   WHERE id=F_old.id;
   
   INSERT INTO memory_edges 
   (source_id, source_type, target_id, target_type, edge_type)
   VALUES (F_new.id, 'semantic', F_old.id, 'semantic', 'supersede');
   ```

---

### Phase 4: Hybrid Retrieval (SYNAPSE + PGMem)

#### 4.1 Query Strategy
```python
def retrieve_memory(query: str, budget: int = 20):
    """Three-stage retrieval"""
    
    # Stage 1: Seed retrieval (semantic + lexical)
    seeds = {
        'subconscious': bm25_search(query, top_k=5) + vector_search(query, top_k=5),
        'episodic': vector_search(query, top_k=5),
        'semantic': vector_search(query, top_k=5)
    }
    
    # Stage 2: Evidence-guided expansion
    expanded = set(seeds)
    for seed in seeds:
        # Traverse support/supersede edges
        expanded.update(traverse_edges(seed, edge_types=['support', 'supersede'], max_hops=2))
    
    # Stage 3: Validity scoring
    for item in expanded:
        support_paths = count_paths(item, edge_type='support')
        contradict_paths = count_paths(item, edge_type='contradict')
        validity_score = support_paths / (support_paths + contradict_paths + 1)
        item.score *= validity_score
    
    # Return top-k by (relevance × validity)
    return sorted(expanded, key=lambda x: x.score, reverse=True)[:budget]
```

#### 4.2 Spreading Activation (optional Phase 5)
- Implement activation-based scoring (SYNAPSE)
- Lateral inhibition to filter noise
- Temporal decay (exponential: score *= e^(-λt))

---

### Phase 5: Active Maintenance

#### 5.1 Reconsolidation (REALM-inspired)
```python
def reconsolidate_on_retrieval(retrieved_items):
    """After each retrieval, strengthen co-retrieved connections"""
    for i, item_a in enumerate(retrieved_items):
        for item_b in retrieved_items[i+1:]:
            # Strengthen edge between co-retrieved items
            existing_edge = get_edge(item_a, item_b, edge_type='related')
            if existing_edge:
                existing_edge.confidence = min(1.0, existing_edge.confidence + 0.05)
            else:
                create_edge(item_a, item_b, edge_type='related', confidence=0.5)
```

#### 5.2 Memory Controller (MemCon-inspired)
```python
class MemoryController:
    """Learned policy: when to retrieve, what to retrieve"""
    
    def should_retrieve(self, query, agent_state):
        # Early sessions: retrieve less (memory is sparse)
        if agent_state.memory_size < 100:
            return False
        
        # Stuck agent: re-retrieve with alternative query
        if agent_state.repeated_actions > 3:
            return True, "alternative_query"
        
        # Recurring goal: prefer plan reuse
        if query.goal_type in agent_state.known_plans:
            return True, "plan_inject"
        
        return True, "standard_retrieve"
```

#### 5.3 Verification (TrustMem-inspired)
```python
def verify_memory_update(old_memory, new_memory, source_evidence):
    """Check coverage, preservation, faithfulness"""
    
    # Coverage: important info preserved?
    coverage = check_coverage(source_evidence, new_memory)
    
    # Preservation: valid old content maintained?
    preservation = check_preservation(old_memory, new_memory)
    
    # Faithfulness: new content supported?
    faithfulness = check_faithfulness(new_memory, source_evidence)
    
    trustworthiness = (coverage + preservation + faithfulness) / 3
    return trustworthiness > 0.7  # Threshold
```

---

## Implementation Roadmap

### Phase 2A: Schema Migration (1-2 days)
- [ ] Rename `episodic_events` → `subconscious_events`
- [ ] Add `embedding` column (use `text-embedding-3-small` or `glm-5.3-flash` embeddings)
- [ ] Create `episodic_memory` table
- [ ] Update `semantic_memory` table (add supersession columns)
- [ ] Create `memory_edges` table

### Phase 2B: Recurrence-Based Consolidation (3-5 days)
- [ ] Implement recurrence detection (cosine similarity clustering)
- [ ] Build episodic consolidation worker (merge-first strategy)
- [ ] Build semantic refinement worker (detail recovery + fact maintenance)
- [ ] Process 5,000 high-value sessions (100+ events each)
- [ ] Cost estimate: 5,000 sessions × $0.01 = $50

### Phase 3: Graph Edges (2-3 days)
- [ ] Implement edge detection (support/contradict/supersede)
- [ ] Build supersession tracker
- [ ] Backfill provenance edges (event → episode → semantic)

### Phase 4: Hybrid Retrieval (2-3 days)
- [ ] Implement seed retrieval (BM25 + vector)
- [ ] Implement graph expansion
- [ ] Implement validity scoring
- [ ] Build MCP server exposing `recall(query)` and `store(event)` APIs

### Phase 5: Active Maintenance (1-2 days)
- [ ] Implement reconsolidation hooks
- [ ] Build memory controller (optional)
- [ ] Add verification layer (optional)

**Total Estimated Time:** 10-15 days  
**Total Estimated Cost:** $50-100 (consolidation) + $10-20 (embeddings)

---

## Addressing User Requirements

| Requirement | Solution | Status |
|------------|----------|--------|
| 1. Lossless merge | ✓ 8M events imported, raw events preserved | DONE |
| 2. Stay up-to-date | Nightly import of new OpenCode sessions | TODO |
| 3. Session search | Hybrid retrieval (Phase 4) | TODO |
| 4. Decision memory | Semantic layer with decision facts | TODO |
| 5. Decision compilation | Supersession tracking via ↝ edges | TODO |
| 6. Session context pickup | Automatic retrieval via memory controller | TODO |
| 7. Problem reuse | Episodic memory with plan injection | TODO |
| 8. Personal knowledge | Semantic facts (preference/knowledge types) | TODO |
| 9. Continuous scanning | Recurrence-based consolidation (not eager) | TODO |
| 10. SOTA research | ✓ This document | DONE |

---

## Key Insights from Research

1. **Don't consolidate everything eagerly** (RecMem): 87% of interactions don't need LLM-level extraction. Use recurrence as the trigger.

2. **Supersession must be explicit** (PGMem): Can't rely on "latest timestamp wins"—need typed ↝ edges to track decision evolution.

3. **Retrieval needs graph structure** (SYNAPSE): Pure vector similarity misses multi-hop connections. "Why did you write X in GitHub comment" → traverse to decision fact → find supporting episode.

4. **Memory evolves through use** (REALM): Co-retrieved items should strengthen their connection. Memory isn't static.

5. **Not all queries need memory** (MemCon): Early sessions, simple tasks, repetitive queries—learn when to skip retrieval.

6. **Verify before storing** (TrustMem): Hallucinated facts compound over time. Check coverage/preservation/faithfulness.

---

## References

1. Dai et al. (2026). "RecMem: Recurrence-based Memory Consolidation for Efficient and Effective Long-Running LLM Agents." arXiv:2605.16045

2. "PGMem: Tightly Coupled Persona–Memory Graph for Lifelong Personalized Agents." arXiv:2608.01708v1

3. Liu et al. (2026). "SYNAPSE: Synergistic Associative Processing & Semantic Encoding." ACL 2026 Findings.

4. Song et al. (2026). "Retrieval-Driven Memory Reconsolidation for Long-Term LLM Agents." arXiv:2609.16053

5. Jiang et al. (2026). "Memory as a Controlled Process: Learned Adaptive Memory Management for LLM Agents." arXiv:2607.13591

6. Yang et al. (2026). "TrustMem: Learning Trustworthy Memory Consolidation for LLM Agents with Long-Term Memory." arXiv:2606.25161

---

## Next Steps

**Immediate (this session):**
1. Review this document with user
2. Get approval on architecture direction
3. Begin Phase 2A (schema migration)

**This week:**
- Complete Phase 2 (recurrence-based consolidation)
- Process 5,000 high-value sessions
- Validate extraction quality

**Next week:**
- Phase 3 (graph edges + supersession)
- Phase 4 (hybrid retrieval + MCP server)

**Within 2 weeks:**
- Agent can natively remember decisions
- Supersession tracking works
- Session context pickup operational

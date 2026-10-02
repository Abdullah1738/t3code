# Phase 2: Semantic Extraction & Entity Graph

## Current State
- ✅ 8,050,446 episodic events imported
- ✅ 34,481 sessions (16,725 Codex, 2,178 Hermes, 15,578 OpenCode)
- ✅ 60 GB database with FTS5 indexes
- ✅ Schema ready with semantic_facts, entities, entity_relationships tables

## Phase 2 Goals

### 1. Semantic Extraction
Extract structured knowledge from raw events:
- **Decisions**: "Never use emojis in commits", "Always use TypeScript for new services"
- **Preferences**: "Prefers Turkish Airlines", "Uses Cursor for development"
- **Solved Problems**: "Docker networking → add host.docker.internal to /etc/hosts"
- **Profile Facts**: "Passport number: ABC123", "Gym: Equinox"
- **Workflows**: "PR review → Linear ticket → attribution"
- **Constraints**: "Crpko dev env uses FoundationDB 7.1.x"

### 2. Supersession Logic
Newer decisions override older ones:
- Track temporal validity (valid_from, valid_until)
- Build supersession chains (supersedes_id, superseded_by_id)
- Mark outdated facts as inactive (is_active = 0)

### 3. Entity Graph
Build relationships between:
- **Sessions** → related sessions, forked from, resumed in
- **Projects** → repositories, services, infrastructure
- **People** → mentioned in context, worked with
- **Skills** → applied in sessions, expertise areas

## Implementation Strategy

### Model Selection: Flash Model (GLM 5.3)
- Fast, cheap extraction
- Local inference via surplus.so
- Already available on this machine
- Good enough for fact extraction (doesn't need Claude-level reasoning)

### Pipeline Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    EXTRACTION PIPELINE                       │
└─────────────────────────────────────────────────────────────┘

1. Session Selector
   ├─ Query: User messages + assistant responses with decisions
   ├─ Filter: Skip tool_result noise, focus on conversations
   └─ Batch: 100 sessions at a time

2. Context Builder
   ├─ Fetch: Session events chronologically
   ├─ Format: Turn-based conversation structure
   └─ Truncate: Keep first 50 + last 50 turns for long sessions

3. Extraction Worker (GLM 5.3)
   ├─ Input: Session conversation + extraction schema
   ├─ Output: JSON array of facts
   └─ Schema: {fact_type, subject, predicate, object, statement, confidence}

4. Supersession Resolver
   ├─ Query: Existing facts by subject
   ├─ Compare: Temporal ordering (newer > older)
   └─ Update: Mark old facts superseded, link chains

5. Entity Extractor
   ├─ Scan: Project names, repo URLs, service names
   ├─ Create: Entity records if new
   └─ Link: Build relationships to sessions

6. Database Writer
   ├─ Insert: semantic_facts with source_event_id citations
   ├─ Update: supersession chains
   └─ Insert: entities + entity_relationships
```

### Extraction Prompt Template

```
You are extracting structured knowledge from a conversation history.

Analyze the following session and extract facts in these categories:

1. DECISIONS - Explicit choices about how to do things
   Example: "Never write emojis in GitHub comments"

2. PREFERENCES - User preferences and favorites
   Example: "Prefers Turkish Airlines for international flights"

3. SOLVED_PROBLEMS - Technical problems and their solutions
   Example: "Docker container can't reach host → add host.docker.internal"

4. PROFILE - Personal information (passport, accounts, memberships)
   Example: "Gym membership: Equinox DTLA"

5. WORKFLOWS - Process patterns and procedures
   Example: "PR review process: Linear ticket first, then code review"

6. CONSTRAINTS - Technical or business constraints
   Example: "Crpko uses FoundationDB 7.1.x in production"

Session:
{conversation}

Return JSON array:
[
  {
    "fact_type": "decision|preference|solved_problem|profile|workflow|constraint",
    "subject": "what is this about?",
    "predicate": "relationship verb",
    "object": "value/target",
    "statement": "human-readable fact",
    "confidence": 0.0-1.0
  }
]

Only extract facts explicitly stated by the user or confirmed by both parties.
Omit speculative or uncertain information.
```

### Batch Processing Strategy

**Sessions to process**: 34,481 total
**Estimated time per session**: 2-5 seconds with flash model
**Total runtime**: ~48-120 hours (2-5 days) for full corpus

**Optimization**:
- Start with high-value sessions (most recent 5,000 from OpenCode/Codex)
- Process in parallel (10 workers)
- Reduce to ~10-15 hours for MVP
- Background process for remaining 29,481 sessions

### Success Metrics

1. **Coverage**: Extract facts from 5,000 sessions (15% of corpus)
2. **Quality**: >80% precision on manual spot-check (50 random facts)
3. **Utility**: Answer 10 test queries from extracted facts
4. **Performance**: <5s retrieval for hybrid BM25 + fact lookup

## Phase 3 Dependencies

This phase unblocks:
- [ ] Hybrid retrieval (BM25 + semantic facts + graph traversal)
- [ ] MCP server (recall/store API)
- [ ] Intent gate (query routing)
- [ ] Session context pickup (automatic memory loading)

## Next Steps

1. Set up GLM 5.3 inference endpoint (surplus.so)
2. Build extraction worker script
3. Test on 10 sample sessions
4. Validate output quality
5. Run batch extraction on 5,000 recent sessions
6. Build supersession resolver
7. Build entity graph extractor

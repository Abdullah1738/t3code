-- Phase 1: Quality-First Architecture Additions
-- Adding evidence edges, causal graph, and user profile compilation tables

-- Evidence edges (PGMem-style) for conflict resolution and validity scoring
CREATE TABLE IF NOT EXISTS evidence_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    source_fact_id INTEGER NOT NULL REFERENCES semantic_facts(id),
    target_fact_id INTEGER NOT NULL REFERENCES semantic_facts(id),
    edge_type TEXT NOT NULL CHECK(edge_type IN ('support', 'contradict', 'supersede', 'related')),
    
    confidence REAL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
    created_at INTEGER NOT NULL,
    source_event_id INTEGER REFERENCES episodic_events(id),
    
    UNIQUE(source_fact_id, target_fact_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_evidence_source ON evidence_edges(source_fact_id);
CREATE INDEX IF NOT EXISTS idx_evidence_target ON evidence_edges(target_fact_id);
CREATE INDEX IF NOT EXISTS idx_evidence_type ON evidence_edges(edge_type);

-- Causal edges (cause → effect relationships)
CREATE TABLE IF NOT EXISTS causal_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    cause_fact_id INTEGER NOT NULL REFERENCES semantic_facts(id),
    effect_fact_id INTEGER NOT NULL REFERENCES semantic_facts(id),
    
    confidence REAL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
    created_at INTEGER NOT NULL,
    source_event_id INTEGER REFERENCES episodic_events(id),
    
    UNIQUE(cause_fact_id, effect_fact_id)
);

CREATE INDEX IF NOT EXISTS idx_causal_cause ON causal_edges(cause_fact_id);
CREATE INDEX IF NOT EXISTS idx_causal_effect ON causal_edges(effect_fact_id);

-- Entity mentions (connect facts to entities)
CREATE TABLE IF NOT EXISTS entity_mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    entity_id INTEGER NOT NULL REFERENCES entities(id),
    fact_id INTEGER NOT NULL REFERENCES semantic_facts(id),
    mention_type TEXT CHECK(mention_type IN ('subject', 'object', 'context')),
    
    UNIQUE(entity_id, fact_id)
);

CREATE INDEX IF NOT EXISTS idx_mention_entity ON entity_mentions(entity_id);
CREATE INDEX IF NOT EXISTS idx_mention_fact ON entity_mentions(fact_id);

-- User profile compilation (User as Code pattern)
CREATE TABLE IF NOT EXISTS user_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    user_id TEXT NOT NULL DEFAULT 'abdullah',
    profile_code TEXT NOT NULL, -- Python code representing compiled user state
    
    last_compiled INTEGER NOT NULL, -- Unix timestamp
    version INTEGER NOT NULL DEFAULT 1,
    
    -- Metadata about what facts were compiled
    fact_count INTEGER DEFAULT 0,
    decision_count INTEGER DEFAULT 0,
    preference_count INTEGER DEFAULT 0,
    profile_count INTEGER DEFAULT 0,
    
    UNIQUE(user_id, version)
);

CREATE INDEX IF NOT EXISTS idx_profile_user ON user_profile(user_id);
CREATE INDEX IF NOT EXISTS idx_profile_version ON user_profile(user_id, version);

-- Memory buffer (MemReader pattern - hold incomplete information)
CREATE TABLE IF NOT EXISTS memory_buffer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    buffer_reason TEXT NOT NULL CHECK(buffer_reason IN ('ambiguous', 'incomplete', 'needs_clarification')),
    
    created_at INTEGER NOT NULL,
    resolved_at INTEGER, -- NULL if still buffered
    resolved_fact_id INTEGER REFERENCES semantic_facts(id), -- Points to fact created after resolution
    
    metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_buffer_session ON memory_buffer(session_id);
CREATE INDEX IF NOT EXISTS idx_buffer_resolved ON memory_buffer(resolved_at);

-- Fact extraction metadata (track quality metrics)
CREATE TABLE IF NOT EXISTS extraction_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    session_id TEXT NOT NULL,
    extracted_at INTEGER NOT NULL,
    
    -- Extraction stats
    events_processed INTEGER DEFAULT 0,
    facts_extracted INTEGER DEFAULT 0,
    facts_buffered INTEGER DEFAULT 0,
    facts_ignored INTEGER DEFAULT 0,
    
    -- Model used
    model TEXT,
    cost_dollars REAL DEFAULT 0.0,
    
    -- Quality signals
    avg_confidence REAL,
    supersessions_detected INTEGER DEFAULT 0,
    contradictions_detected INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_extraction_session ON extraction_metadata(session_id);
CREATE INDEX IF NOT EXISTS idx_extraction_time ON extraction_metadata(extracted_at);

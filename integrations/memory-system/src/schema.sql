-- Memory System Schema
-- Three parallel stores: Episodic, Semantic, Entity-Graph

-- ====================
-- EPISODIC: Full timeline of all conversations
-- ====================

CREATE TABLE IF NOT EXISTS episodic_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Provenance
    source TEXT NOT NULL CHECK(source IN ('codex', 'hermes', 'opencode')),
    session_id TEXT NOT NULL,
    turn_id TEXT,
    timestamp INTEGER NOT NULL, -- Unix timestamp
    speaker TEXT NOT NULL CHECK(speaker IN ('user', 'assistant', 'system')),
    
    -- Content
    content TEXT NOT NULL,
    content_type TEXT NOT NULL CHECK(content_type IN ('text', 'tool_call', 'tool_result', 'code', 'error')),
    
    -- Metadata
    model TEXT,
    tokens_used INTEGER,
    metadata_json TEXT, -- Additional structured data
    
    -- Search optimization
    content_fts TEXT, -- For full-text search
    
    UNIQUE(source, session_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_episodic_timestamp ON episodic_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_episodic_session ON episodic_events(source, session_id);
CREATE INDEX IF NOT EXISTS idx_episodic_speaker ON episodic_events(speaker);

-- Full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS episodic_fts USING fts5(
    content,
    content='episodic_events',
    content_rowid='id'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS episodic_fts_insert AFTER INSERT ON episodic_events BEGIN
    INSERT INTO episodic_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS episodic_fts_delete AFTER DELETE ON episodic_events BEGIN
    DELETE FROM episodic_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS episodic_fts_update AFTER UPDATE ON episodic_events BEGIN
    DELETE FROM episodic_fts WHERE rowid = old.id;
    INSERT INTO episodic_fts(rowid, content) VALUES (new.id, new.content);
END;


-- ====================
-- SEMANTIC: Extracted facts & decisions
-- ====================

CREATE TABLE IF NOT EXISTS semantic_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Fact content
    fact_type TEXT NOT NULL CHECK(fact_type IN ('decision', 'preference', 'solved_problem', 'profile', 'workflow', 'constraint')),
    subject TEXT NOT NULL, -- What is this about? (e.g., "GitHub comments", "airline preference", "Docker networking")
    predicate TEXT NOT NULL, -- The relationship/assertion (e.g., "never_write", "prefers", "solution_for")
    object TEXT NOT NULL, -- The value/target (e.g., "emojis", "Turkish Airlines", "add host.docker.internal")
    
    -- Natural language representation
    statement TEXT NOT NULL, -- Human-readable: "Never write emojis in GitHub comments"
    
    -- Provenance (citation lock)
    source_event_id INTEGER NOT NULL REFERENCES episodic_events(id),
    extracted_at INTEGER NOT NULL, -- Unix timestamp
    confidence REAL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
    
    -- Temporal supersession
    supersedes_id INTEGER REFERENCES semantic_facts(id), -- Points to older fact this replaces
    superseded_by_id INTEGER REFERENCES semantic_facts(id), -- Points to newer fact that replaces this
    valid_from INTEGER NOT NULL, -- Unix timestamp
    valid_until INTEGER, -- NULL means currently valid
    is_active INTEGER DEFAULT 1 CHECK(is_active IN (0, 1)),
    
    -- Search optimization
    statement_fts TEXT
);

CREATE INDEX IF NOT EXISTS idx_semantic_type ON semantic_facts(fact_type);
CREATE INDEX IF NOT EXISTS idx_semantic_subject ON semantic_facts(subject);
CREATE INDEX IF NOT EXISTS idx_semantic_active ON semantic_facts(is_active, valid_until);
CREATE INDEX IF NOT EXISTS idx_semantic_supersedes ON semantic_facts(supersedes_id);

-- Full-text search for facts
CREATE VIRTUAL TABLE IF NOT EXISTS semantic_fts USING fts5(
    statement,
    subject,
    content='semantic_facts',
    content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS semantic_fts_insert AFTER INSERT ON semantic_facts BEGIN
    INSERT INTO semantic_fts(rowid, statement, subject) VALUES (new.id, new.statement, new.subject);
END;

CREATE TRIGGER IF NOT EXISTS semantic_fts_delete AFTER DELETE ON semantic_facts BEGIN
    DELETE FROM semantic_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS semantic_fts_update AFTER UPDATE ON semantic_facts BEGIN
    DELETE FROM semantic_fts WHERE rowid = old.id;
    INSERT INTO semantic_fts(rowid, statement, subject) VALUES (new.id, new.statement, new.subject);
END;


-- ====================
-- ENTITY-GRAPH: Sessions, projects, people
-- ====================

CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Entity identification
    entity_type TEXT NOT NULL CHECK(entity_type IN ('session', 'project', 'person', 'skill', 'repository', 'service')),
    entity_name TEXT NOT NULL,
    entity_id_external TEXT, -- External ID (e.g., GitHub repo, session UUID)
    
    -- Metadata
    description TEXT,
    created_at INTEGER NOT NULL,
    last_active INTEGER,
    metadata_json TEXT,
    
    UNIQUE(entity_type, entity_name)
);

CREATE TABLE IF NOT EXISTS entity_relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Relationship
    from_entity_id INTEGER NOT NULL REFERENCES entities(id),
    relationship_type TEXT NOT NULL, -- 'related_to', 'part_of', 'solved_in', 'mentioned_in', 'worked_on'
    to_entity_id INTEGER NOT NULL REFERENCES entities(id),
    
    -- Provenance
    source_event_id INTEGER REFERENCES episodic_events(id),
    created_at INTEGER NOT NULL,
    strength REAL DEFAULT 1.0, -- Relationship weight for graph traversal
    
    UNIQUE(from_entity_id, relationship_type, to_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entity_name ON entities(entity_name);
CREATE INDEX IF NOT EXISTS idx_rel_from ON entity_relationships(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_rel_to ON entity_relationships(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_rel_type ON entity_relationships(relationship_type);


-- ====================
-- IMPORT METADATA
-- ====================

CREATE TABLE IF NOT EXISTS import_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK(source IN ('codex', 'hermes', 'opencode')),
    import_started_at INTEGER NOT NULL,
    import_completed_at INTEGER,
    total_events INTEGER DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('in_progress', 'completed', 'failed')),
    error_message TEXT,
    metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_import_source ON import_status(source);


-- ====================
-- CONSOLIDATION QUEUE
-- ====================

CREATE TABLE IF NOT EXISTS consolidation_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES episodic_events(id),
    queued_at INTEGER NOT NULL,
    processed_at INTEGER,
    status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'failed')) DEFAULT 'pending',
    error_message TEXT,
    
    UNIQUE(event_id)
);

CREATE INDEX IF NOT EXISTS idx_consolidation_status ON consolidation_queue(status, queued_at);

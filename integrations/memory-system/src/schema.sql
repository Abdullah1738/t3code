-- Session history store (memory.db). Everything recall reads.
-- episodic_text_fts (contentless, user/assistant text) is built by build_text_fts.py.

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

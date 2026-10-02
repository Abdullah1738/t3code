-- Correct triggers for external-content FTS5 tables.
-- A plain `DELETE FROM fts WHERE rowid=...` in an AFTER trigger does not remove the
-- old tokens or the docsize row for external-content tables; the 'delete' command
-- with the old column values is required. The update trigger on semantic_facts is
-- scoped to the indexed columns so metadata updates (is_active, superseded_by_id,
-- valid_until) never touch the index.
BEGIN IMMEDIATE;
DROP TRIGGER IF EXISTS episodic_fts_delete;
DROP TRIGGER IF EXISTS episodic_fts_update;
DROP TRIGGER IF EXISTS semantic_fts_delete;
DROP TRIGGER IF EXISTS semantic_fts_update;

CREATE TRIGGER episodic_fts_delete AFTER DELETE ON episodic_events BEGIN
    INSERT INTO episodic_fts(episodic_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER episodic_fts_update AFTER UPDATE OF content ON episodic_events BEGIN
    INSERT INTO episodic_fts(episodic_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO episodic_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER semantic_fts_delete AFTER DELETE ON semantic_facts BEGIN
    INSERT INTO semantic_fts(semantic_fts, rowid, statement, subject) VALUES ('delete', old.id, old.statement, old.subject);
END;
CREATE TRIGGER semantic_fts_update AFTER UPDATE OF statement, subject ON semantic_facts BEGIN
    INSERT INTO semantic_fts(semantic_fts, rowid, statement, subject) VALUES ('delete', old.id, old.statement, old.subject);
    INSERT INTO semantic_fts(rowid, statement, subject) VALUES (new.id, new.statement, new.subject);
END;
COMMIT;

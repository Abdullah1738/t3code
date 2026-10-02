CREATE TRIGGER episodic_fts_delete AFTER DELETE ON episodic_events BEGIN
    DELETE FROM episodic_fts WHERE rowid = old.id;
END;
CREATE TRIGGER episodic_fts_update AFTER UPDATE ON episodic_events BEGIN
    DELETE FROM episodic_fts WHERE rowid = old.id;
    INSERT INTO episodic_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER semantic_fts_delete AFTER DELETE ON semantic_facts BEGIN
    DELETE FROM semantic_fts WHERE rowid = old.id;
END;
CREATE TRIGGER semantic_fts_update AFTER UPDATE ON semantic_facts BEGIN
    DELETE FROM semantic_fts WHERE rowid = old.id;
    INSERT INTO semantic_fts(rowid, statement, subject) VALUES (new.id, new.statement, new.subject);
END;

python3 - <<'PY'
from pathlib import Path
p=Path('app/data/aurora_stores/cms_read/unrepaired.py');s=p.read_text();s=s.replace('f"SELECT encode(canonical_key,','f"SELECT encode(canonical_key,',1)
# Identifiers derive exclusively from AuroraSchemaStore's validated schema.
s=s.replace('f"SELECT encode(canonical_key,\'hex\') AS canonical_key, action_changed_at_ms, "','f"SELECT encode(canonical_key,\'hex\') AS canonical_key, action_changed_at_ms, "  # noqa: S608')
s=s.replace('f"SELECT kind, count(*) AS count FROM {self.table} GROUP BY kind",','f"SELECT kind, count(*) AS count FROM {self.table} GROUP BY kind",  # noqa: S608')
s=s.replace('f"SELECT revision::text FROM {self.table} WHERE canonical_key=decode(:key,\'hex\')",','f"SELECT revision::text FROM {self.table} WHERE canonical_key=decode(:key,\'hex\')",  # noqa: S608')
s=s.replace('f"INSERT INTO {self.table} (canonical_key, kind, identity_jsonb, action_changed_at_ms, "','f"INSERT INTO {self.table} "  # noqa: S608\n            "(canonical_key, kind, identity_jsonb, action_changed_at_ms, "')
s=s.replace('"(decode(:key,\'hex\'), :kind, CAST(:identity AS jsonb), :changed, CAST(:action AS uuid), "','"(decode(:key,\'hex\'), :kind, CAST(:identity AS jsonb), :changed, "\n            "CAST(:action AS uuid), "').replace('"identity_jsonb=EXCLUDED.identity_jsonb, action_changed_at_ms=EXCLUDED.action_changed_at_ms, "','"identity_jsonb=EXCLUDED.identity_jsonb, "\n            "action_changed_at_ms=EXCLUDED.action_changed_at_ms, "').replace('"action_id=EXCLUDED.action_id, delete_id=EXCLUDED.delete_id, revision=EXCLUDED.revision, "','"action_id=EXCLUDED.action_id, delete_id=EXCLUDED.delete_id, "\n            "revision=EXCLUDED.revision, "')
s=s.replace('f"DELETE FROM {self.table} WHERE canonical_key=decode(:key,\'hex\') "','f"DELETE FROM {self.table} WHERE canonical_key=decode(:key,\'hex\') "  # noqa: S608')
p.write_text(s)
PY
uv run --no-sync ruff check --fix app/worker/cms_publication_check.py app/data/aurora_stores/cms_read/unrepaired.py
uv run --no-sync ruff format app/worker/cms_publication_check.py app/data/aurora_stores/cms_read/unrepaired.py
offbox run --bg --include tmp/restart/postgres.sh -- bash tmp/restart/postgres.sh
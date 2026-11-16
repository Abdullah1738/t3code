cat >> tests/test_completion_reader_grants.py <<'PY'


def test_rds_reader_cannot_teardown_even_with_matching_creator_lease(tmp_path):
    env, store = authority(), backend(tmp_path, [1000])
    op = operation("creator")
    resource = "principal:rds:cluster-ABC123:reader"
    held = acquire_leases(env, [scope("reader", resource, "exclusive")], op, store)
    own = ReaderOwnership(schema_version=V, source_id="source", cluster=env.cluster,
        incarnation=env.incarnation, physical_source="rds:cluster-ABC123", principal="reader",
        principal_incarnation="42", operation_id=op.id, owner_operation_id=op.id,
        lease_ref=op.holder_id, origin="created", resource_ref=resource, proof=_artifact())
    try:
        assert not may_teardown_reader(own, [held])
    finally:
        release_leases(held, cleanup(), store)
PY
python3 -I - <<'PY'
from pathlib import Path
p=Path('tests/test_completion_reader_grants.py');s=p.read_text();s=s.replace('# Columns exposed to the QA role. session_id is a live backoffice credential\n# and the attribution / params columns can carry operator data, so they stay\n# out. Matching uses the per-run operator id, route, method and time window.\n\n\n','');p.write_text(s)
p=Path('src/harness/completion/reader_grants.py');s=p.read_text().replace('    """Require complete inventory, exact permissions and both independent controls."""','    """Require complete inventory, the pinned permission policy and both controls."""');p.write_text(s)
PY
PYTHONPATH=src:.:scripts /Users/ardud/CrpkoArchitectureBroker/tmp/crpko-integration-harness/.venv/bin/python -m pytest -q tests/test_completion_reader_grants.py
offbox logs run-1115-042456-2c84
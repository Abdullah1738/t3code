python3 - <<'PY'
from pathlib import Path
p=Path('tests/test_qa_access.py');s=p.read_text();s=s.replace('from harness import qa_access as qa','from contextlib import contextmanager\n\nfrom harness import qa_access as qa');s=s.replace('@pytest.fixture(scope="module")\ndef audit_postgres():','@contextmanager\ndef _audit_postgres(image, container=None):');s=s.replace('        def qualify(self):','        def qualify(self, change=None):');old='''            return qa.QAAccess().audit_qualify(self, spec.model_copy(update=identity), own.model_copy(update=identity),
                controls=(), expires_at_ms=9999999999999,
                read_window=lambda: tuple(c.model_copy(update=identity | {"observed_at_ms": int(time.time() * 1000)})
                                         for c in controls))
    if container := os.environ.get("AUDIT_TEST_CONTAINER"):
''';new='''            def read_window():
                if change:  # Interleave the fixture admin's external catalog change.
                    self._run_sql(change)
                return tuple(c.model_copy(update=identity | {"observed_at_ms": int(time.time() * 1000)}) for c in controls)
            return qa.QAAccess().audit_qualify(self, spec.model_copy(update=identity), own.model_copy(update=identity),
                controls=(), expires_at_ms=9999999999999, read_window=read_window)
    if container:
''';assert old in s;s=s.replace(old,new).replace('            qa.READER_IMAGE], check=True, capture_output=True, timeout=180)','            image], check=True, capture_output=True, timeout=180)');s=s.replace('            "CREATE TYPE backoffice.qa_enum AS ENUM (\'one\'); "','''            "CREATE TYPE backoffice.qa_enum AS ENUM ('one'); SELECT lo_create(900001); CREATE ROLE qa_acl_other; "''');s=s.replace('            "REVOKE ALL ON ALL TABLES IN SCHEMA pg_catalog, information_schema FROM PUBLIC; "','''            "REVOKE ALL ON ALL TABLES IN SCHEMA pg_catalog, information_schema FROM PUBLIC; "
            "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_catalog, information_schema FROM PUBLIC; "''');needle='\n\n@pytest.mark.parametrize("grant", ["SELECT ON pg_catalog.pg_statistic",';s=s.replace(needle,'''\n\n@pytest.fixture(scope="module")
def audit_postgres():
    with _audit_postgres(qa.READER_IMAGE, os.environ.get("AUDIT_TEST_CONTAINER")) as postgres:
        yield postgres
'''+needle)
s+='''

@pytest.mark.parametrize("grant", ["UPDATE ON LARGE OBJECT 900001",
    "SET, ALTER SYSTEM ON PARAMETER log_statement", "EXECUTE ON FUNCTION pg_catalog.lo_create(oid)"])
def test_public_write_acl_cannot_qualify_with_equal_brackets(grant, audit_postgres):
    assert audit_postgres.qualify().qualified
    try:
        audit_postgres._run_sql(f"GRANT {grant} TO PUBLIC;")
        receipt = audit_postgres.qualify()
        assert receipt.effective.epoch_kind == "bracketed"
        assert "effective capability is not a supported read-only permission" in receipt.issues
        assert not receipt.qualified and not receipt.observer_grant().effective_permissions
    finally:
        audit_postgres._run_sql(f"REVOKE {grant} FROM PUBLIC;")


@pytest.mark.parametrize("grant", ["UPDATE ON LARGE OBJECT 900001", "ALTER SYSTEM ON PARAMETER log_statement"])
def test_acl_epoch_covers_unrelated_grantee_changes(grant, audit_postgres):
    assert audit_postgres.qualify().qualified
    try:
        receipt = audit_postgres.qualify(f"GRANT {grant} TO qa_acl_other;")
        assert set(receipt.effective.permissions) == set(receipt.spec.allowed)
        assert receipt.effective.epoch_kind == "unknown"
        assert "PostgreSQL catalog changed between epoch brackets" in receipt.issues
        assert not receipt.qualified and not receipt.observer_grant().effective_permissions
    finally:
        audit_postgres._run_sql(f"REVOKE {grant} FROM qa_acl_other;")


def test_null_acl_defaults_allow_reads_and_reject_temp(audit_postgres):
    audit_postgres._run_sql("CREATE TYPE backoffice.qa_null AS ENUM ('one'); CREATE DATABASE qa_null_acl;")
    try:
        assert audit_postgres._run_sql("SELECT typacl IS NULL FROM pg_type WHERE oid='backoffice.qa_null'::regtype;").strip() == "t"
        blocked = audit_postgres.qualify()
        assert any(p.endswith(":TEMPORARY") for p in blocked.effective.permissions)
        assert not blocked.qualified
        audit_postgres._run_sql("DROP DATABASE qa_null_acl; GRANT USAGE ON SCHEMA pg_catalog TO PUBLIC; "
            "GRANT EXECUTE ON FUNCTION pg_catalog.abs(integer) TO PUBLIC;")
        allowed = audit_postgres.qualify()
        assert allowed.qualified, allowed.issues
    finally:
        audit_postgres._run_sql("DROP DATABASE IF EXISTS qa_null_acl; DROP TYPE backoffice.qa_null; "
            "REVOKE USAGE ON SCHEMA pg_catalog FROM PUBLIC; REVOKE EXECUTE ON FUNCTION pg_catalog.abs(integer) FROM PUBLIC;")


def test_parameter_catalog_absence_is_recorded_on_postgres14():
    with _audit_postgres("postgres:14-alpine@sha256:b084304744d27cbc34513a1d2916129bd6a33383fa17b79b9a9030a950f14870") as postgres:
        receipt = postgres.qualify()
        assert receipt.qualified, receipt.issues
        assert receipt.effective.absent_catalogs == ("pg_parameter_acl",)
''';p.write_text(s)
PY
mkdir -p tmp/hc022r2-r3
mv _apalache-out tmp/quint/2147/catalog-acl-apalache-out
git diff --check
python3 - <<'PY'
import subprocess
rows=subprocess.check_output(['git','diff','--numstat','11d5c004a60eef8a3047692414b07cc40ebddad8'],text=True).splitlines();print('\n'.join(rows));print('total',sum(int(a)+int(b) for a,b,_ in (x.split('\t') for x in rows)))
PY
offbox run --no-fallback -- timeout 1200 bash -c 'PYTHONPATH=src:. uv run pytest -q tests/test_qa_access.py tests/test_completion_reader_grants.py tests/test_qa_access_kafka.py' > tmp/hc022r2-r3/focused.log 2>&1
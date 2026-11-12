cat > tmp/quint/2359/tests_budget.py <<'PY'
from pathlib import Path
p=Path('tests/internal/compliance_kyc/test_api_runtime.py');s=p.read_text();s=s.replace('from app.api.compliance_kyc.verified_identity import (','from app.api.compliance_kyc.verified_name import (\n    handle_get_verified_name_request,\n)\nfrom app.service.compliance_kyc.api_runtime import build_get_verified_name_use_case\nfrom app.infra.compliance_kyc.api_routing import DynamoDbAccountRoutingIndex, DynamoDbClient\nfrom tests.internal.compliance_kyc.test_verified_name import _RoutingDynamoDb\nfrom app.api.compliance_kyc.verified_identity import (')
# Avoid circular import: keep routing fixture here and import it in test_verified_name instead.
s=s.replace('from tests.internal.compliance_kyc.test_verified_name import _RoutingDynamoDb\n','')
helper='''def _verified_read_request(*, provider: ApiRouteRuntimeStateProvider, verified_name: bool):
    if not verified_name:
        return handle_get_verified_identity_request(
            path_with_query=f"/internal/v1/kyc/verified-identity?account_id={ACCOUNT_ID}",
            use_case=_verified_identity_use_case(provider=provider),
        )
    from tests.internal.compliance_kyc.test_verified_name import _RoutingDynamoDb

    return handle_get_verified_name_request(
        path_with_query=f"/internal/v1/kyc/verified-name?account_id={ACCOUNT_ID}",
        use_case=build_get_verified_name_use_case(
            routing_index=DynamoDbAccountRoutingIndex(client=cast(DynamoDbClient, _RoutingDynamoDb())),
            runtime_state_provider=provider,
            read_store_factory=_BackofficeReadStoreFactoryStub(
                stores_by_dsn={SHARD_WRITER_DSN: _BackofficeReadStoreStub(profile_record=_backoffice_profile_record())}
            ),
            application_name=APPLICATION_NAME,
            statement_timeout_ms=STATEMENT_TIMEOUT_MS,
            pool_max_conns=POOL_MAX_CONNS,
        ),
    )


'''
# Explicit annotation and top-level local import from new file is a cycle only at execution, fine.
helper=helper.replace('verified_name: bool):','verified_name: bool) -> VerifiedIdentityHttpResult | VerifiedNameHttpResult:')
s=s.replace('    handle_get_verified_name_request,','    handle_get_verified_name_request,\n    VerifiedNameHttpResult,');s=s.replace('    GetVerifiedIdentityUseCase,','    GetVerifiedIdentityUseCase,\n    VerifiedIdentityHttpResult,');s=s.replace('def _verified_identity_use_case(',helper+'def _verified_identity_use_case(')
for name in ['Test_STATUS_013_verified_identity_sumsub_call_stops_at_route_budget','Test_STATUS_014_saturated_sumsub_pool_returns_503_without_sumsub_call','Test_STATUS_013_stalled_dns_never_piles_up_sumsub_attempt_threads']:
 start=s.index('def '+name+'(');end=s.index('\n\ndef ',start+5) if '\n\ndef ' in s[start+5:] else len(s)
 # don't consume unrelated constants, only operate within function body
 block=s[start:end]
 block=block.replace(') -> None:',') -> None:',1)
 if '() -> None:' in block: block=block.replace('() -> None:', '(verified_name: bool) -> None:',1)
 else: block=block.replace('    monkeypatch: pytest.MonkeyPatch,','    monkeypatch: pytest.MonkeyPatch,\n    verified_name: bool,',1)
 import re
 block=re.sub(r'handle_get_verified_identity_request\(\n\s+path_with_query=f"/internal/v1/kyc/verified-identity\?account_id=\{ACCOUNT_ID\}",\n\s+use_case=(?:_verified_identity_use_case\(provider=provider\)|use_case),\n\s+\)', '_verified_read_request(provider=provider, verified_name=verified_name)',block)
 block=block.replace('        use_case = _verified_identity_use_case(provider=provider)\n','').replace('    use_case = _verified_identity_use_case(provider=provider)\n','')
 # pick the metrics for the route under test
 block=block.replace("        rendered = metrics.render_prometheus_text()", "        rendered = metrics.render_prometheus_text()\n        route = 'verified_name' if verified_name else 'verified_identity'")
 block=block.replace("    rendered = metrics.render_prometheus_text()", "    rendered = metrics.render_prometheus_text()\n    route = 'verified_name' if verified_name else 'verified_identity'",1) if name.endswith('threads') else block
 block=block.replace("'route=\"verified_identity\",reason=\"pool_saturated\"} 1'", "f'route=\"{route}\",reason=\"pool_saturated\"}} 1'")
 block=block.replace('f\'route="verified_identity",reason="attempt_capacity"', 'f\'route="{route}",reason="attempt_capacity"')
 s=s[:start]+'@pytest.mark.parametrize("verified_name", [False, True], ids=["identity", "name-STATUS-019"])\n'+block+s[end:]
p.write_text(s)
PY
python3 tmp/quint/2359/tests_budget.py
/Users/ardud/compliance-kyc/.venv/bin/ruff check app tests/internal/compliance_kyc/test_verified_name.py tests/internal/compliance_kyc/test_api_runtime.py tests/internal/compliance_kyc/test_start_kyc_route.py --fix
/Users/ardud/compliance-kyc/.venv/bin/ruff format tests/internal/compliance_kyc/test_api_runtime.py tests/internal/compliance_kyc/test_verified_name.py
/Users/ardud/compliance-kyc/.venv/bin/python -m pytest tests/internal/compliance_kyc/test_verified_name.py -x
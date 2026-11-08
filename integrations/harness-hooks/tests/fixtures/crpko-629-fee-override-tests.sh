cat > tmp/quint/629/tests.py <<'PY'
from pathlib import Path
p=Path('tests/worker/handlers/test_user_fee_override_receipts.py');s=p.read_text();s=s.replace('def action(*, nested: bool = True, scope: str = "GLOBAL")','def action(*, nested: bool = True, scope: str = "GLOBAL", clear: bool = False)');s=s.replace('payload_jsonb={"fee_override": fee} if nested else fee,','payload_jsonb={"fee_override": None} if clear else {"fee_override": fee} if nested else fee,')
for name,args in [('test_new_account_override_and_receipt_commit_together',''),('test_delayed_retry_preserves_later_account_changes','newer: str'),('test_same_action_concurrent_commit_recovers_without_second_write','response_lost: bool'),('test_version_cas_loser_does_not_commit_a_row_or_receipt','existing: bool'),('test_fee_cas_does_not_erase_a_concurrent_bulk_tag_update','')]:
 a=s.index('def '+name+'(');b=s.find('\n\n',s.index('\n    ',a));end=s.find('\n\n\n',a)
 if end==-1:end=len(s)
 block=s[a:end].replace('def '+name+'('+args+')','def '+name+'('+(args+', ' if args else '')+'clear: bool)').replace('action()','action(clear=clear)')
 s=s[:a]+'@pytest.mark.parametrize("clear", (False, True))\n'+block+s[end:]
s += '''

@pytest.mark.parametrize("row_shape", ("nested", "flat"))
def test_clear_preserves_siblings_and_provenance_and_replays_without_put(row_shape: str) -> None:
    env = environment(row_shape=row_shape)
    record = action(clear=True)
    old = deepcopy(env.resource.tables_by_name[OVERRIDES].item_by_key[ACCOUNT])
    assert env.handler.execute(action=record, timeout_ms=1000).success
    row = env.resource.tables_by_name[OVERRIDES].item_by_key[ACCOUNT]
    assert isinstance(row, Mapping) and isinstance(old, Mapping)
    assert row["fee_override"] is None
    assert row["version"] == 8
    assert row["approval_request_id"] == ACTION
    assert row["reason"] == record.reason
    for key in ("user_tag", "bonus_perps_collateral_cap_usdt_atomic", "vip_tier_id_override",
                "vip_lock_expires_at_ms", "created_by", "created_at_ms"):
        assert row[key] == old[key]
    assert not any(key in row for key in ("fee_override_scope", "fee_override_instrument_id", "maker_bps", "taker_bps"))
    current = env.store.get_current_user_trading_override(account_id=ACCOUNT)
    assert current is not None
    assert (current.fee_override_scope, current.fee_override_instrument_id,
            current.maker_bps, current.taker_bps) == (None, None, None, None)
    assert not current.fee_override_malformed
    before = env.snapshot()
    assert env.handler.execute(action=replace(record, attempts=2), timeout_ms=1000).success
    assert env.snapshot() == before
    assert len(env.client.transact_write_calls) == 1
    assert len(env.resource.tables_by_name[OVERRIDES].put_item_calls) == 1


def test_zero_fee_pair_remains_an_override() -> None:
    env = environment()
    record = replace(action(), payload_jsonb={"fee_override": {"scope": "GLOBAL", "maker_bps": 0, "taker_bps": 0}})
    assert env.handler.execute(action=record, timeout_ms=1000).success
    current = env.store.get_current_user_trading_override(account_id=ACCOUNT)
    assert current is not None
    assert (current.fee_override_scope, current.maker_bps, current.taker_bps) == ("GLOBAL", 0, 0)


@pytest.mark.parametrize("payload", (
    {},
    {"fee_override": {"scope": "GLOBAL", "maker_bps": None, "taker_bps": None}},
    {"fee_override": {"scope": "GLOBAL", "maker_bps": 0, "taker_bps": None}},
    {"fee_override": {"scope": None, "maker_bps": 0, "taker_bps": 0}},
    {"scope": None, "maker_bps": None, "taker_bps": None},
))
def test_partial_and_flat_nulls_never_clear(payload: Mapping[str, object]) -> None:
    env = environment()
    before = env.snapshot()
    outcome = env.handler.execute(action=replace(action(), payload_jsonb=payload), timeout_ms=1000)
    assert not outcome.success and outcome.error_code == "BO_REQUEST_INVALID"
    assert env.snapshot() == before and env.client.transact_write_calls == []


@pytest.mark.parametrize("scope,resource_id", (("GLOBAL", ACCOUNT), ("ACCOUNT", "invalid")))
def test_clear_keeps_account_scope_and_uuid_checks(scope: str, resource_id: str) -> None:
    env = environment()
    record = replace(action(clear=True), resource_scope=scope, resource_id=resource_id)
    before = env.snapshot()
    outcome = env.handler.execute(action=record, timeout_ms=1000)
    assert not outcome.success and outcome.error_code == "BO_REQUEST_INVALID"
    assert env.snapshot() == before and env.client.transact_write_calls == []
'''
p.write_text(s)
p=Path('tests/test_user_fee_override_receipts_dynamodb.py');s=p.read_text()
for name,args in [('test_actual_fee_receipt_recovers_without_overwriting_a_later_fee',None),('test_actual_fee_cas_loses_to_concurrent_bulk_tag',None)]:
 a=s.index('def '+name+'(');end=s.find('\n\n\n',a);end=len(s) if end<0 else end
 block=s[a:end]
 if name.endswith('later_fee'):
  block=block.replace('lost_response: bool','lost_response: bool, clear: bool')
 else: block=block.replace('legacy: bool','legacy: bool, clear: bool')
 block=block.replace('    seed(env', '    if clear:\n        env.action = replace(env.action, payload_jsonb={"fee_override": None})\n    seed(env',1)
 if name.endswith('later_fee'):block=block.replace('    assert row["version"]', '    if clear:\n        assert row["fee_override"] == {"NULL": True}\n    assert row["version"]',1)
 s=s[:a]+'@pytest.mark.parametrize("clear", (False, True))\n'+block+s[end:]
p.write_text(s)
PY
python3 tmp/quint/629/tests.py
/Users/ardud/backoffice-core/.venv/bin/python -m ruff format tests/worker/handlers/test_user_fee_override_receipts.py tests/test_user_fee_override_receipts_dynamodb.py
/Users/ardud/backoffice-core/.venv/bin/python -m pytest -q tests/worker/handlers/test_user_fee_override_receipts.py
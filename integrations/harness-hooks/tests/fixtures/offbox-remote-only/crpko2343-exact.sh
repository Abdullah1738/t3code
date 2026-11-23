cat > tmp/pr444-r2.rgLbUX/probe.py <<'PY'
"""Read-only checkout review; mutants live only in TemporaryDirectory copies."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path.cwd()
artifacts = Path(__file__).resolve().parent / 'results'
artifacts.mkdir(exist_ok=True)
worker = 'tests/worker/handlers/test_action_handler.py'
due = 'tests/worker/handlers/test_due_delisting.py'
clear = 'tests/worker/handlers/test_user_fee_override_receipts.py::test_clear_preserves_siblings_and_provenance_and_replays_without_put'
instrument_tests = [
    'test_worker_action_execution_handler_executes_instrument_halt',
    'test_worker_action_execution_handler_executes_instrument_schedule_delisting',
    'test_exinst_025_worker_action_execution_handler_executes_instrument_modify',
    'test_worker_action_execution_handler_executes_fee_set_instrument_default',
    'test_worker_executes_global_fee_default_without_loading_instrument_state',
    'test_worker_action_execution_handler_executes_perp_set_bbook_enabled',
    'test_worker_action_execution_handler_executes_perp_set_bbp_default',
    'test_worker_action_execution_handler_executes_instrument_copy_config',
    'test_worker_action_execution_handler_executes_instrument_schedule_listing',
    'test_worker_action_execution_handler_repairs_already_applied_past_schedule_listing',
]
policy_tests = [
    'test_worker_action_execution_handler_executes_perp_set_user_tag',
    'test_worker_action_execution_handler_executes_perp_user_policy_bulk_apply',
    'test_worker_action_execution_handler_executes_perp_bbp_bucket_update',
    'test_worker_action_execution_handler_executes_perp_bbp_bucket_delete',
    'test_worker_action_execution_handler_executes_perp_slippage_policy_update',
    'test_worker_action_execution_handler_executes_perp_slippage_policy_delete',
    'test_worker_action_execution_handler_executes_fee_set_vip_tier_schedule_fanout',
]

def run(name, cwd, tests, expected):
    # Isolated Python explicitly puts only this test copy first on the import path.
    launcher = 'import sys;sys.path.insert(0,sys.argv.pop(1));import pytest;raise SystemExit(pytest.main(sys.argv[1:]))'
    cmd = [sys.executable, '-I', '-c', launcher, str(cwd), *tests, '-o', 'addopts=', '-q', '--tb=short']
    result = subprocess.run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (artifacts/(name+'.log')).write_text(result.stdout)
    print(f'{name}: expected={expected} actual={result.returncode}', flush=True)
    print('\n'.join(result.stdout.splitlines()[-26:]), flush=True)
    if result.returncode != expected:
        raise SystemExit(f'Unexpected result for {name}; see {artifacts/name}')
    return {'name':name,'exit_code':result.returncode,'expected_exit':expected,'log':str(artifacts/(name+'.log'))}

results=[]
cases=[
    ('instrument-wrong-action-id', 'app/worker/handlers/instrument.py',
     'approval_request_id=action.approval_request_id,', 'approval_request_id=action.action_id,',
     [worker+'::'+n for n in instrument_tests]),
    ('policy-wrong-action-id', 'app/worker/handlers/trading_policy.py',
     'approval_request_id=action.approval_request_id,', 'approval_request_id=action.action_id,',
     [worker+'::'+n for n in policy_tests]+[clear]),
    ('due-delisting-wrong-action-id', 'app/domain/registry/instrument_execution/service.py',
     'approval_request_id=request.approval_request_id,', 'approval_request_id=request.action_id,',
     [due+'::test_exinst_038_entry_and_completion_run_in_one_pass_when_already_flat']),
    ('clear-domain-wrong-action-id', 'app/domain/registry/fee_execution.py',
     'approval_request_id=request.approval_request_id,', 'approval_request_id=request.action_id if request.clear else request.approval_request_id,',
     [clear]),
]
# All targeted controls must pass unmodified first.
selected=list(dict.fromkeys(t for c in cases for t in c[-1]))
results.append(run('controls-at-head',root,selected,0))
for name,path,old,new,tests in cases:
    with tempfile.TemporaryDirectory(prefix='pr444-negative-') as tmp:
        copy=Path(tmp)
        for directory in ('app','tests'):
            shutil.copytree(root/directory,copy/directory,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
        shutil.copy2(root/'pyproject.toml',copy/'pyproject.toml')
        target=copy/path
        source=target.read_text()
        if name == 'clear-domain-wrong-action-id':
            start=source.index('    def execute_fee_set_user_override(')
            end=source.index('\n    def ',start+5)
            section=source[start:end]
            assert section.count(old)==1
            source=source[:start]+section.replace(old,new)+source[end:]
        else:
            assert source.count(old)>0
            source=source.replace(old,new)
        target.write_text(source)
        results.append(run(name,copy,tests,1))
(artifacts/'summary.json').write_text(json.dumps(results,indent=2))
print('ALL NEGATIVE CONTROLS PRODUCED EXPECTED ASSERTION FAILURES',flush=True)
PY
offbox run --bg --include tmp/pr444-r2.rgLbUX --pull tmp/pr444-r2.rgLbUX/results -- 'uv sync --all-extras --dev --frozen && uv run pytest tests/contract/test_registry_approval_identity.py tests/contract/test_registry_writer_contract.py tests/infra/registry/test_vip_registry_store.py tests/test_fee_writer_occ.py tests/worker/handlers/test_action_handler.py tests/worker/test_instrument_execution.py tests/worker/handlers/test_due_delisting.py tests/worker/handlers/test_user_fee_override_receipts.py tests/worker/test_fx_execution.py tests/worker/test_asset_execution.py -o addopts= -q && uv run python -I tmp/pr444-r2.rgLbUX/probe.py'

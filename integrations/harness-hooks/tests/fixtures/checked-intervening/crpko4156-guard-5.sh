cat > /Volumes/ExternalSSD/board-wt/harness-4156/tests/test_ephemeral_producer_latch.py <<'EOF'
"""Exercise the vendored validator through the QA lifecycle boundary."""
import json
import os
import subprocess
from pathlib import Path

import pytest

from harness.ephemeral import admission, lifecycle, producer_latch, workspace as wsm


@pytest.fixture
def qa(tmp_path, monkeypatch, qa_capacity):
    ws = wsm.prepare("qa12", zone_id="ZQA", runner_cidrs=[], root=tmp_path / "envs")
    binary = tmp_path / "bin"
    binary.mkdir()
    state = tmp_path / "ssm.json"
    state.write_text("{}")
    monkeypatch.setenv("QA_LATCH_STATE", str(state))
    monkeypatch.setenv("PATH", f"{binary}:{os.environ['PATH']}")
    aws = binary / "aws"
    aws.write_text('''#!/usr/bin/env node
const fs = require('node:fs'), a = process.argv.slice(2);
const path = process.env.QA_LATCH_STATE, state = JSON.parse(fs.readFileSync(path));
const arg = k => a[a.indexOf(k)+1];
let result = {};
if(a[0] === 'sts') result = {Account: '434793037400'};
else if(a[0] === 'ssm') {
 const name = arg('--name');
 if(!name.startsWith('/crpko/qa12/')) throw Error('foreign path');
 if(state.denied) { process.stderr.write('(AccessDeniedException)'); process.exit(1); }
 if(a[1] === 'get-parameter') {
  if(!state[name]) { process.stderr.write('(ParameterNotFound)'); process.exit(1); }
  result = {Parameter: {Name: name, Type: 'String', Value: JSON.stringify(state[name])}};
 } else if(a[1] === 'put-parameter') {
  if(!a.includes('--no-overwrite')) throw Error('overwrite');
  if(state[name]) { process.stderr.write('(ParameterAlreadyExists)'); process.exit(1); }
  state[name] = JSON.parse(arg('--value')); state.puts = (state.puts || 0)+1;
 } else if(a[1] === 'delete-parameter') { delete state[name]; state.deletes = (state.deletes || 0)+1; }
 else throw Error('unexpected operation');
 fs.writeFileSync(path, JSON.stringify(state));
} else throw Error('unexpected service');
console.log(JSON.stringify(result));
''')
    aws.chmod(0o700)
    return ws, state


def held_plan():
    return {"variables": {k: {"value": v} for k, v in {
        "rebuild_producer_hold": True, "dev_backoffice_bootstrap_hold": True,
        "registry_publisher_stream_enabled": False}.items()}, "resource_changes": []}


def test_create_retry_conflict_and_unknown_identity(qa, monkeypatch):
    ws, state = qa
    first = producer_latch.invoke(ws, "create")
    assert first["env"] == ws.env and first["region"] == "ap-south-2"
    assert producer_latch.invoke(ws, "create") == first
    assert json.loads(state.read_text())["puts"] == 1
    monkeypatch.setattr(admission, "native_input", lambda *a: {"installation_id": "01a1eeee-1234-7123-8123-123456789abd"})
    with pytest.raises(RuntimeError, match="HOLD_LATCH_CONFLICT"):
        producer_latch.invoke(ws, "create")
    assert json.loads(state.read_text())[f"/crpko/{ws.env}/rebuild/producer-hold"] == first


@pytest.mark.parametrize("branch", ["saved", "direct", "no-plan"])
@pytest.mark.parametrize("bad", ["missing", "dev", "qa34", "account", "region", "unreadable", "unsafe"])
def test_apply_refuses_before_any_mutation(qa, monkeypatch, branch, bad):
    ws, state = qa
    producer_latch.invoke(ws, "create")
    doc = json.loads(state.read_text())
    latch = doc[f"/crpko/{ws.env}/rebuild/producer-hold"]
    if bad == "missing": del doc[f"/crpko/{ws.env}/rebuild/producer-hold"]
    elif bad in ("dev", "qa34"): latch["env"] = bad
    elif bad == "account": latch["account_id"] = "111111111111"
    elif bad == "region": latch["region"] = "ap-south-1"
    elif bad == "unreadable": doc["denied"] = True
    state.write_text(json.dumps(doc))
    value = held_plan()
    if bad == "unsafe":
        value["resource_changes"] = [{"mode": "managed", "type": "aws_appautoscaling_target", "address": 'module.ecs_runtime.aws_appautoscaling_target.service["trading-core-outbox-publisher"]',
            "change": {"after": {"resource_id": "service/crpko-qa12/crpko-qa12-trading-core-outbox-publisher", "min_capacity": 1, "max_capacity": 1}}}]
    plan = ws.root / "tfplan"
    if branch != "no-plan": plan.write_text("saved plan")
    calls = []
    def tf(w, *args, **kwargs):
        calls.append(args)
        if args[0] == "plan": plan.write_text("new exact plan")
        return subprocess.CompletedProcess(args, 0, json.dumps(value), "")
    monkeypatch.setattr(lifecycle, "_tf", tf)
    with pytest.raises(RuntimeError, match="HOLD_"):
        lifecycle.apply(ws, *(["-target=module.ecs_runtime"] if branch == "direct" else []))
    assert not any(a[0] == "apply" for a in calls)
    assert not json.loads(state.read_text()).get("deletes")


def test_both_apply_routes_use_the_validated_plan_and_keep_latch(qa, monkeypatch):
    ws, state = qa
    latch = producer_latch.invoke(ws, "create")
    calls = []
    def tf(w, *args, **kwargs):
        calls.append(args)
        if args[0] == "plan":
            variables = Path(next(a.split("=", 1)[1] for a in args if a.startswith("-var-file=") and "hold-" in a))
            assert json.loads(variables.read_text()) == {k: v["value"] for k, v in held_plan()["variables"].items()}
            (ws.root / "tfplan").write_text("exact")
        return subprocess.CompletedProcess(args, 0, json.dumps(held_plan()), "")
    monkeypatch.setattr(lifecycle, "_tf", tf)
    lifecycle.plan(ws)
    lifecycle.apply(ws)
    lifecycle.apply(ws, "-target=module.ecs_runtime")
    assert [a[0] for a in calls] == ["plan", "show", "apply", "plan", "show", "apply"]
    assert all(a[-1] == str(ws.root / "tfplan") for a in calls if a[0] == "apply")
    assert json.loads(state.read_text())[f"/crpko/{ws.env}/rebuild/producer-hold"] == latch


def test_teardown_keeps_latch_on_partial_failure_then_deletes_last(qa, monkeypatch):
    ws, state = qa
    producer_latch.invoke(ws, "create")
    monkeypatch.setattr(lifecycle, "workspace", lambda env: ws)
    monkeypatch.setattr(lifecycle, "_session", lambda *a: type("Session", (), {"client": lambda *a: None})())
    monkeypatch.setattr(lifecycle, "_tf", lambda *a, **k: None)
    monkeypatch.setattr(lifecycle.zone_mod, "destroy", lambda *a: None)
    monkeypatch.setattr(lifecycle.teardown, "prune_appconfig", lambda *a, **k: [])
    monkeypatch.setattr(lifecycle.teardown, "sweep", lambda *a, **k: {})
    left = ["ecs task draining"]
    def residue(*a, **k):
        assert k["ignore_producer_latch"]
        assert not json.loads(state.read_text()).get("deletes")
        return list(left)
    monkeypatch.setattr(lifecycle.teardown, "residue", residue)
    with pytest.raises(RuntimeError, match="residue"):
        lifecycle.destroy(ws.env)
    assert producer_latch.invoke(ws, "variables")
    left.clear()
    lifecycle.destroy(ws.env, keep_workspace=True)
    assert json.loads(state.read_text())["deletes"] == 1
EOF
python3 -I - <<'PY'
from pathlib import Path
p=Path('scripts/ci_offline_policy.json');s=p.read_text().replace('    "tests/test_ephemeral_native.py",','    "tests/test_ephemeral_native.py",\n    "tests/test_ephemeral_producer_latch.py",');p.write_text(s)
PY
PYTHONPATH=src /Users/ardud/CrpkoArchitectureBroker/tmp/crpko-integration-harness/.venv/bin/python -m pytest tests/test_ephemeral_producer_latch.py -q -x
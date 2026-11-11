python3 - <<'PY'
from pathlib import Path
p=Path('tmp/carry-3207/resolve.py');s=p.read_text().replace(' raise RuntimeError(i)\nresolve(\'app/worker/campaign_progress_runtime.py\'', ' if i==6:return a\n raise RuntimeError(i)\nresolve(\'app/worker/campaign_progress_runtime.py\'');p.write_text(s)
PY
python3 /Users/ardud/checkouts/rewards-nv1-carry/tmp/carry-3207/resolve.py
python3 -m compileall -q app
uv run --no-sync ruff format app/data/trigger_mutations.py app/domain/bonus/conditions.py app/domain/kol/service.py app/worker/campaign_progress_runtime.py app/worker/campaign_trigger_preparation.py app/worker/metrics_runtime.py tests/test_grant_completion_evidence.py
uv run --no-sync ruff check app/data/trigger_mutations.py app/domain/bonus/conditions.py app/domain/kol/service.py app/worker/campaign_progress_runtime.py app/worker/campaign_trigger_preparation.py app/worker/metrics_runtime.py tests/test_grant_completion_evidence.py
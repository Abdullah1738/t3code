python3 - <<'PY'
from pathlib import Path
import shutil
source=Path('/Volumes/ExternalSSD/crpko-devops/tmp/3070/sol-r2')
target=Path('tmp/3070/r2')
target.mkdir(parents=True,exist_ok=True)
shutil.copy(source/'test_lock_expiry.py',target/'test_lock_expiry.py')
runner=Path('tmp/3070/r1/run.sh').read_text()
runner=runner.replace('uv run pytest tests/test_perps_cap_crash_dynamodb.py tests/test_perps_cap_lease_dynamodb.py -k \'cap\' -vv', '''uv run python -c 'import sys; sys.path.insert(0,"scripts"); from run_registry_timeline_dynamodb_proof import _wait_for_endpoint; import os; _wait_for_endpoint(os.environ["REGISTRY_TIMELINE_DYNAMODB_ENDPOINT_URL"])'
  if [[ "$mode" == probe ]]; then
    uv run pytest tmp/3070/r2/test_lock_expiry.py -vv
  else
    uv run pytest tests/test_perps_cap_crash_dynamodb.py tests/test_perps_cap_lease_dynamodb.py -k 'cap' -vv
  fi''')
(target/'run.sh').write_text(runner)
PY
offbox run --include tmp/3070/r2 -- bash tmp/3070/r2/run.sh probe
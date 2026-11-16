python3 -I - <<'PY'
from pathlib import Path
p=Path('scripts/ci_offline_policy.json');s=p.read_text().replace('    "tests/test_ephemeral_native.py",','    "tests/test_ephemeral_native.py",\n    "tests/test_ephemeral_producer_latch.py",');p.write_text(s)
PY
PYTHONPATH=src /Users/ardud/CrpkoArchitectureBroker/tmp/crpko-integration-harness/.venv/bin/python -m pytest tests/test_ephemeral_producer_latch.py -q -x
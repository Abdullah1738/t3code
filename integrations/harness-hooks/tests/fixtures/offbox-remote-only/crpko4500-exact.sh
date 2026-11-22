cat > tmp/evidence/4500/base-proof.wNRqhS/check.py <<'PY'
import pathlib
import subprocess
import xml.etree.ElementTree as ET

xml = pathlib.Path('tmp/evidence/4500/base-proof.xml')
result = subprocess.run(['uv', 'run', 'pytest', 'tests/internal/compliance_kyc/test_metrics_shutdown.py', f'--junitxml={xml}'])
suites = ET.parse(xml).getroot()
cases = list(suites.iter('testcase'))
failures = list(suites.iter('failure'))
errors = list(suites.iter('error'))
print(f'BASE_PROOF pytest_exit={result.returncode} tests={len(cases)} failures={len(failures)} errors={len(errors)}', flush=True)
assert result.returncode == 1 and len(cases) == 8 and len(failures) == 8 and not errors
PY
offbox run --bg --include tmp/evidence/4500 --pull tmp/evidence/4500 -- 'uv sync --python 3.14 --all-extras --dev --frozen && uv run python -I tmp/evidence/4500/base-proof.wNRqhS/check.py'

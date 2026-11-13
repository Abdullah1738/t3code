"""Run built-in-only fixtures and print one captured line per instrumented name."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

repo = Path(__file__).resolve().parents[3]
with tempfile.TemporaryDirectory(prefix='9router-fixtures-') as scratch:
    root = Path(scratch)
    capture = root / 'capture.ndjson'
    env = dict(os.environ, ROUTER_LOG_DIR=str(root / 'logs'), ROUTER_LOG_CAPTURE=str(capture))
    subprocess.run([sys.executable, '-I', str(repo / 'integrations/router-logging/test/test_logging.py')], cwd=repo, env=env, check=True)
    files = [str(p) for package in ['router-logging', 'catalog-guard', 'stream-recovery'] for p in (repo / 'integrations' / package / 'test').glob('*.test.mjs')]
    subprocess.run(['node', '--test', *files], cwd=repo, env=env, check=True)
    samples = {}
    for path in [capture, *(root / 'logs').glob('*.ndjson')]:
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            try:
                row = json.loads(line)
                if row.get('tool') == '9router':
                    samples.setdefault(row['name'], row)
            except (ValueError, KeyError):
                pass
    for name in sorted(samples):
        print('SAMPLE ' + json.dumps(samples[name], separators=(',', ':')))

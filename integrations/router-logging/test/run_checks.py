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
    subprocess.run([sys.executable, '-I', '-m', 'unittest', 'discover', '-s', str(repo / 'integrations/router-logging/test'), '-p', 'test_*.py'], cwd=repo, env=env, check=True)
    files = [str(p) for package in ['router-logging', 'catalog-guard', 'stream-recovery'] for p in (repo / 'integrations' / package / 'test').glob('*.test.mjs')]
    subprocess.run(['node', '--test', *files], cwd=repo, env=env, check=True)
    with tempfile.TemporaryDirectory(prefix='9router-test-home-') as home:
        isolated_env = dict(os.environ, HOME=home)
        isolated_env.pop('ROUTER_LOG_DIR', None)
        isolated_env.pop('ROUTER_LOG_CAPTURE', None)
        isolated_files = [str(p) for package in ['catalog-guard', 'stream-recovery'] for p in (repo / 'integrations' / package / 'test').glob('*.test.mjs')]
        subprocess.run(['node', '--test', *isolated_files], cwd=repo, env=isolated_env, check=True)
        assert not (Path(home) / '.robob/logs/tools/9router').exists(), 'test fixtures reached the home log directory'
        print('ISOLATION stream-recovery and catalog-guard: home log directory absent', flush=True)
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
    fixture_codes = {'TEST_CUTOVER_UNAVAILABLE', 'TEST_SEND_FAILED', 'TEST_DISPATCH_FAILED', 'TEST_LEDGER_UNAVAILABLE'}
    emitted_codes = set()
    for path in [capture, *(root / 'logs').glob('*.ndjson')]:
        if path.exists():
            for line in path.read_text().splitlines():
                try:
                    row = json.loads(line)
                    code = row.get('error', {}).get('tag')
                    if code in fixture_codes:
                        assert row['error']['message'] == code, row
                        emitted_codes.add(code)
                except (ValueError, KeyError):
                    pass
    assert emitted_codes >= fixture_codes, fixture_codes - emitted_codes
    for name in sorted(samples):
        print('SAMPLE ' + json.dumps(samples[name], separators=(',', ':')))

cat > tmp/142/campaign.py <<'FIXTURE_EOF'
import json, os, subprocess, sys
from pathlib import Path
root = Path(os.environ['PWD'])
load = sys.argv[1] == 'loaded'
count = int(sys.argv[2])
pids = []
rows = []
try:
    if load:
        for _ in range(os.cpu_count()):
            pids.append(subprocess.Popen(['yes'], stdout=subprocess.DEVNULL))
    print(f'CAMPAIGN load={load} cpus={os.cpu_count()} load_pids={[p.pid for p in pids]} root={root}', flush=True)
    for n in range(1, count + 1):
        os.chdir(root)
        dest = Path(f'tmp/142/{sys.argv[1]}/{n:03}')
        command = ['python3', 'scripts/run-unit-tests.py', '--tests', 'com.usdtwallet.app.SwapWalletTest', '--log-dir', str(dest)]
        rc = subprocess.run(command).returncode
        os.chdir(root)
        result = json.loads((dest / 'result.json').read_text()) if (dest / 'result.json').exists() else {}
        row = dict(iteration=n, rc=rc, tests=result.get('tests'), failures=result.get('failures'), phases=result.get('phases'))
        rows.append(row)
        Path(f'tmp/142/{sys.argv[1]}-summary.json').write_text(json.dumps(rows, indent=2))
        print('CLASS_RESULT ' + json.dumps({k:v for k,v in row.items() if k != 'phases'}), flush=True)
finally:
    for p in pids:
        p.terminate()
    for p in pids:
        p.wait()
    print('LOAD_STOPPED', flush=True)
sys.exit(int(any(r['rc'] for r in rows)))
FIXTURE_EOF

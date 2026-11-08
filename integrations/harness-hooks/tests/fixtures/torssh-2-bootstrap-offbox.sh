mkdir -p scripts && cat > scripts/bootstrap-offbox.py <<'PY'
#!/usr/bin/env python3
"""Explicit network-enabled provisioning. Normal checks never run this file."""
import hashlib, json, os, pathlib, re, shutil, subprocess, sys, tarfile, urllib.request, zipfile
ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = pathlib.Path.home() / '.cache/torssh'
TOOLS = CACHE / 'tools'
TOOLS.mkdir(parents=True, exist_ok=True)
DOC = (ROOT / 'docs/DEPENDENCIES.md').read_text()
ROWS = ['Gradle **8.14.4**', 'Temurin OpenJDK', 'CMake **4.1.2**', 'GNU Make', 'Node.js', 'Apalache **0.62.4**', 'NDK **r29', 'Android platform', 'SDK Build Tools']
lockpath = ROOT / 'scripts/toolchain-lock.json'
lock = json.loads(lockpath.read_text()) if lockpath.exists() else {}
record = '--record-toolchain' in sys.argv
for row in ROWS:
    line = next(x for x in DOC.splitlines() if x.startswith('| ' + row))
    url = re.search(r'\[(?:download|source)\]\((https:[^)]+)\)', line).group(1)
    expected = re.search(r'(?:SHA256|SHA1)\** `([a-f0-9]+)`', line).group(1)
    name = url.rsplit('/', 1)[1]
    archive = CACHE / name
    if not archive.exists():
        print('Downloading', name, flush=True)
        urllib.request.urlretrieve(url, archive.with_suffix('.part'))
        archive.with_suffix('.part').rename(archive)
    sha256 = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
    actual = sha256 if len(expected) == 64 else hashlib.file_digest(archive.open('rb'), 'sha1').hexdigest()
    if actual != expected:
        raise SystemExit(f'CONTRACT DIGEST MISMATCH {name}: expected {expected}; received {actual}; SHA256 {sha256}')
    if name not in lock and not record:
        raise SystemExit('Missing SHA256 lock for ' + name + '; explicit --record-toolchain required')
    if name in lock and lock[name]['sha256'] != sha256:
        raise SystemExit('Toolchain lock mismatch: ' + name)
    lock[name] = {'url':url, 'sha256':sha256}
    if record:
        lockpath.write_text(json.dumps(lock, indent=2) + '\n')
    dest = TOOLS / name.replace('.tar.gz','').replace('.tar.xz','').replace('.tgz','').replace('.zip','')
    if not dest.exists():
        dest.mkdir()
        if name.endswith('.zip'):
            with zipfile.ZipFile(archive) as z: z.extractall(dest)
        else:
            with tarfile.open(archive) as t: t.extractall(dest, filter='data')
    print('Verified', name, sha256, flush=True)
print('Tool archives verified and extracted', flush=True)
PY
cat > scripts/bootstrap-offbox.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Provision on Linux x86_64 offbox only' >&2; exit 1; }
python3 scripts/bootstrap-offbox.py "$@"
SH
chmod +x scripts/bootstrap-offbox.sh
 offbox run --no-fallback --pull scripts/toolchain-lock.json -- ./scripts/bootstrap-offbox.sh --record-toolchain
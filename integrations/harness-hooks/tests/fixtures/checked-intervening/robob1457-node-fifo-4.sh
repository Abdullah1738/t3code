python3 -I - <<'PY'
from pathlib import Path
p=Path('apps/server/src/ardud/control/t3ctl.test.ts')
s=p.read_text().replace('const result = await invoke("0.05");','const result = await invoke("0.5");')
p.write_text(s)
PY
node --test --test-name-pattern='watchdog' apps/server/src/ardud/control/t3ctl-live-cli.test.mjs > /Volumes/ExternalSSD/t3code-fork/tmp/1457-r2.l2TB3L/green-stages.log 2>&1
task_scratch=$(mktemp -d)
python3 -I - "$task_scratch" <<'PY'
from pathlib import Path
import subprocess
import sys
scratch = Path(sys.argv[1])
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
body = Path('/tmp/937-final-handoff.md').read_text().replace('HEAD_SHA', head)
body = body.replace('Independent full-diff review: /tmp/937-review-r12.md.', 'Independent whole-diff precommit review: PASS, no correctness findings. /tmp/937-review-r12.md independently passed 564 tests and 155 direct assertions, and verified the exact reviewed tree/index/worktree stayed unchanged.')
body = body.replace('Latest origin/main ', 'Last checked origin/main ')
files = subprocess.check_output(['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], text=True).splitlines()
body = body.replace('<the19changedTypeScriptFiles>', ' '.join(files))
body += '\nRemote verification: origin/fix/claude-model-fallback matches ' + head + '; worktree is clean. Reviewed tree: 70e8b7662b792e36ba3a2bd80879e9dd7fa5c912.\n'
path = scratch / 'handoff.md'
path.write_text(body)
print(path)
PY

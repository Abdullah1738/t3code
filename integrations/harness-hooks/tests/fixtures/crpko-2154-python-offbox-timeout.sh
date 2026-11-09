python3 - <<'PY'
from pathlib import Path
import shutil
p=Path('tmp/hc021d')
for name in ('broker.tar','devops.bundle'):
 shutil.copyfile(Path('/Volumes/ExternalSSD/board-wt/crpko-integration-harness-HC-021c/tmp/hc021c')/name,p/name)
s=Path('/Volumes/ExternalSSD/board-wt/crpko-integration-harness-HC-021c/tmp/hc021c/check.sh').read_text().replace('tmp/hc021c','tmp/hc021d')
s=s.replace('git rev-parse HEAD \'HEAD^{tree}\'','git rev-parse HEAD \'HEAD^{tree}\'\nsha256sum src/harness/completion/observer_source.py src/harness/completion/reader_grants.py tests/test_completion_observer_source.py docs/completion/observer-source.md')
s=s.replace('tests/test_completion_gateway_coverage.py tests/test_async_observers.py','tests/test_completion_gateway_coverage.py tests/test_completion_reader_grants.py tests/test_async_observers.py')
s=s.replace('timeout 180 uv run pytest','set +e\ntimeout 180 uv run pytest',1).replace('timeout 1800 uv run pytest -v --durations=10','focused=$?\ntimeout 1800 uv run pytest -q --durations=10\nfull=$?\necho "FOCUSED_EXIT=$focused FULL_EXIT=$full"\nexit "$((focused || full))"')
(p/'check.sh').write_text(s)
PY
 offbox run --remote --git --include tmp/hc021d/check.sh --include tmp/hc021d/broker.tar --include tmp/hc021d/devops.bundle -- timeout 2100 bash tmp/hc021d/check.sh > tmp/hc021d/offbox-precommit.log 2>&1
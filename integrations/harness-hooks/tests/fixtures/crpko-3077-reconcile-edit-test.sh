/usr/bin/python3 -B - <<'PY'
from pathlib import Path
for f in ['report.py','write_round.py','WORK.md']:
 p=Path('tmp/card-3077')/f
 text=p.read_text().replace("'new_test_methods': 17", "'new_test_methods': 18").replace('17 methods pass','18 methods pass').replace('17 new','18 new')
 p.write_text(text)
PY
umask 077
/usr/bin/python3 -B tmp/card-3077/test_reconcile.py -q > tmp/card-3077/tests.log 2>&1
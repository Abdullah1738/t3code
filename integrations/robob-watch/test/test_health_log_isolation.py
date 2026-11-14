"""Real entry points, synthetic HOME, no inherited log override or credentials."""
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

PACKAGE = Path(__file__).resolve().parents[1]
VAULT = Path(os.environ['HEALTH_VAULT_TEST_COPY']).resolve() if os.environ.get('HEALTH_VAULT_TEST_COPY') else None

LAUNCH = '''
import json, runpy, sqlite3, sys, types
from pathlib import Path
script, marker, expected_root = sys.argv[1:4]
sys.argv = [script] + sys.argv[4:]
sys.path.insert(0, str(Path(script).parent))
if marker == 'unittest':
    import unittest
if script.endswith('/validate.py'):
    def unavailable(*a, **kw):
        raise RuntimeError('synthetic unavailable database')
    sqlite3.connect = unavailable
if '/forge-workouts/' in script:
    report = types.ModuleType('report')
    report.LATEST = str(Path.home() / 'missing-forge-fixture.json')
    report.last_change_ms = lambda w: 0
    report.load_doc = lambda **kw: {'payload': {'workouts': []}}
    sys.modules['report'] = report
status = 0
try:
    runpy.run_path(script, run_name='__main__')
except SystemExit as exc:
    status = exc.code if isinstance(exc.code, int) else int(exc.code is not None)
except (RuntimeError, FileNotFoundError):
    status = 1
assert 'toollog' in sys.modules, 'entry point did not import logging'
assert Path(sys.modules['toollog'].__file__).resolve() == Path(expected_root) / 'toollog.py'
print('__ENTRY_STATUS__=' + str(status))
'''


@unittest.skipIf(VAULT is None, 'provide HEALTH_VAULT_TEST_COPY with staged source files')
class EntryPointIsolationTests(unittest.TestCase):
    def check_entry(self, rel, args=(), watcher=False, expected_status=0):
        # Run each detector alone. The final case proves a real entry point emits with an override.
        for marker in ('HEALTH_VAULT_TEST_COPY', 'PYTEST_CURRENT_TEST', 'unittest', 'override'):
            with self.subTest(marker=marker), tempfile.TemporaryDirectory() as temp:
                home = Path(temp)
                vault = home / 'health-data/abdullah'
                watch = home / '.local/share/robob-watch'
                # Copy source allowlists only, even if the caller points at a populated vault.
                for source, destination, files in (
                    (VAULT, vault, ('toollog.py', 'toollog_rollup.py', 'nutrition/food.py',
                                    'nutrition/nlib.py', 'cards/cards.py', 'whoop/whoop.py',
                                    'hlog.py', 'validate.py')),
                    (PACKAGE, watch, ('toollog.py', 'watchers/meds-nag/check.py', 'watchers/meds-nag/took.py',
                                      'watchers/gym-nudge/check.py', 'watchers/forge-workouts/check.py'))):
                    for name in files:
                        target = destination / name
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(source / name, target)
                root = watch if watcher else vault
                script = root / rel
                live = home / '.robob/logs/tools/health'
                live.mkdir(parents=True)
                day = dt.datetime.now(dt.timezone.utc).date().isoformat()
                (live / (day + '.ndjson')).write_text('{}\n')
                (live / '2026-11-13.ndjson').write_text('{}\n')
                (live / 'rollup-2000-01-01.json').write_text('{}\n')
                def snapshot():
                    return {str(p.relative_to(live)): (p.stat().st_size, p.stat().st_mtime_ns)
                            for p in [live] + sorted(live.iterdir())}
                before = snapshot()
                env = {'HOME': str(home), 'PATH': os.defpath, 'WATCH_DIR': str(script.parent),
                       'NUTRITION_DB': str(home / 'synthetic-nutrition.db')}
                # No copy of os.environ: even a configured agent-wide override must not mask a leak.
                if marker == 'override':
                    env['HEALTH_TOOLLOG_DIR'] = str(home / 'isolated')
                    env['HEALTH_VAULT_TEST_COPY'] = str(vault)
                elif marker != 'unittest':
                    env[marker] = str(vault) if marker == 'HEALTH_VAULT_TEST_COPY' else 'entrypoint-test'
                result = subprocess.run([sys.executable, '-I', '-c', LAUNCH, str(script), marker,
                                         str(root), *args], env=env, capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('__ENTRY_STATUS__=' + str(expected_status), result.stdout)
                self.assertEqual(snapshot(), before, 'default live log directory changed')
                if marker == 'override':
                    rows = [json.loads(line) for p in (home / 'isolated').glob('*.ndjson')
                            for line in p.read_text().splitlines()]
                    self.assertTrue(rows, 'entry point did not exercise its log write')
                    self.assertFalse(any('test' in row.get('props', {}) for row in rows))

    def test_food(self):
        self.check_entry('nutrition/food.py', ['--help'])

    def test_cards(self):
        self.check_entry('cards/cards.py', ['--help'])

    def test_whoop(self):
        self.check_entry('whoop/whoop.py', ['status'])

    def test_took(self):
        self.check_entry('watchers/meds-nag/took.py', watcher=True, expected_status=1)

    def test_hlog(self):
        self.check_entry('hlog.py')

    def test_validate(self):
        self.check_entry('validate.py', expected_status=1)

    def test_meds_nag(self):
        self.check_entry('watchers/meds-nag/check.py', watcher=True)

    def test_gym_nudge(self):
        self.check_entry('watchers/gym-nudge/check.py', watcher=True)

    def test_forge_workouts(self):
        self.check_entry('watchers/forge-workouts/check.py', watcher=True, expected_status=1)

    def test_rollup(self):
        self.check_entry('toollog_rollup.py', ['--day', '2026-11-13'])


if __name__ == '__main__':
    unittest.main()

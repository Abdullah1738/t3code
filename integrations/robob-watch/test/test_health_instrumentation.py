"""Run real entry points with isolated files and fake external services."""
import ast
import contextlib
import datetime as dt
import io
import json
import os
from pathlib import Path
import shutil
import site
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

PACKAGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE))
import toollog


class Clock(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 11, 13, 20, 0, tzinfo=tz)


class FixtureHook(ast.NodeTransformer):
    def visit_If(self, node):
        if ast.unparse(node.test) == "__name__ == '__main__'":
            return [ast.Expr(ast.Call(ast.Name('__fixture__', ast.Load()),
                                     [ast.Call(ast.Name('globals', ast.Load()), [], [])], [])), node]
        return self.generic_visit(node)


class InstrumentationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.logs = self.root / 'logs'
        self.home = self.root / 'home'
        self.home.mkdir()
        self.watch = self.root / 'watch'
        self.watch.mkdir()
        self.env = mock.patch.dict(os.environ, HEALTH_TOOLLOG_DIR=str(self.logs), WATCH_DIR=str(self.watch),
                                   NUTRITION_NOW='2026-11-13T23:00:00')
        self.env.start()
        self.addCleanup(self.env.stop)
        self.vault = Path(os.environ.get('HEALTH_VAULT_TEST_COPY', self.root / 'absent'))
        if self.vault.resolve() == Path('/Users/ardud/health-data/abdullah').resolve():
            self.fail('HEALTH_VAULT_TEST_COPY must be a throwaway copy')

    def rows(self):
        return [json.loads(line) for p in self.logs.glob('*.ndjson') for line in p.read_text().splitlines()]

    def tearDown(self):
        destination = os.environ.get('HEALTH_TOOLLOG_SAMPLES')
        if destination:
            with open(destination, 'a') as fh:
                for row in self.rows():
                    fh.write(json.dumps(row) + '\n')

    def run_script(self, path, args=(), fixture=lambda g: None, patches=()):
        tree = ast.fix_missing_locations(FixtureHook().visit(ast.parse(path.read_text())))
        code = compile(tree, str(path), 'exec')
        original = os.path.expanduser

        def expand(value):
            if value.startswith('~/health-data/abdullah'):
                return str(self.vault.parent / 'home/health-data/abdullah') + value[len('~/health-data/abdullah'):]
            if value.startswith('~/.local/share/robob-watch/watchers/meds-nag'):
                return str(self.watch) + value[len('~/.local/share/robob-watch/watchers/meds-nag'):]
            return str(self.home) + value[1:] if value.startswith('~/') else original(value)

        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(sys, 'argv', [str(path)] + list(args)))
            stack.enter_context(mock.patch.object(sys, 'path', [str(path.parent), str(self.vault), str(self.vault / 'nutrition'), site.getusersitepackages()] + sys.path))
            stack.enter_context(mock.patch.object(os.path, 'expanduser', side_effect=expand))
            stack.enter_context(mock.patch.object(Path, 'home', return_value=self.home))
            stack.enter_context(mock.patch.object(dt, 'datetime', Clock))
            self.stdout, self.stderr = io.StringIO(), io.StringIO()
            stack.enter_context(contextlib.redirect_stdout(self.stdout))
            stack.enter_context(contextlib.redirect_stderr(self.stderr))
            for patch in patches:
                stack.enter_context(patch)
            status = 0
            try:
                exec(code, {'__name__': '__main__', '__file__': str(path), '__fixture__': fixture})
            except SystemExit as exc:
                status = 0 if exc.code in (None, 0) else 1
            except Exception as exc:
                self.exception = type(exc).__name__
                status = 1
        return status

    def assert_run(self, component, status, name='cli.run'):
        row = [r for r in self.rows() if r['component'] == component and r['name'] == name][-1]
        self.assertEqual(row['ok'], status == 0)
        if status:
            self.assertIn('error', row)

    def test_real_watcher_run_triggers_and_fold_override(self):
        for value in ('schedule', 'retry', 'manual', 'unknown', 'private-trigger'):
            expected = value if value in toollog.TRIGGERS else 'unknown'
            with mock.patch.dict(os.environ, HEALTH_TOOLLOG_TRIGGER=value):
                for component in ('meds-nag', 'gym-nudge'):
                    with self.subTest(component=component, value=value):
                        self.assertEqual(self.run_script(PACKAGE / 'watchers' / component / 'check.py'), 0)
                        row = [r for r in self.rows() if r['component'] == component and r['name'] == 'watcher.run'][-1]
                        self.assertEqual(row['props']['trigger'], expected)
                self.assertEqual(self.run_script(PACKAGE / 'watchers/meds-nag/check.py', ['--fold']), 0)
                self.assertEqual([r for r in self.rows() if r['name'] == 'watcher.run'][-1]['props']['trigger'], 'chained')
        with mock.patch.dict(os.environ, {}, clear=True):
            # Keep explicit test destinations while exercising the emitter's manual default.
            os.environ.update(HEALTH_TOOLLOG_DIR=str(self.logs), WATCH_DIR=str(self.watch))
            self.assertEqual(self.run_script(PACKAGE / 'watchers/meds-nag/check.py'), 0)
            self.assertEqual([r for r in self.rows() if r['name'] == 'watcher.run'][-1]['props']['trigger'], 'manual')

    def test_real_vault_sync_and_nutrition_trigger_boundaries(self):
        if not self.vault.exists():
            self.skipTest('set HEALTH_VAULT_TEST_COPY')
        nutrition = self.vault / 'nutrition'
        (nutrition / 'watch.off').touch()
        try:
            for value in ('schedule', 'retry', 'chained', 'manual', 'private-trigger'):
                expected = value if value in toollog.TRIGGERS else 'unknown'
                with mock.patch.dict(os.environ, HEALTH_TOOLLOG_TRIGGER=value):
                    for arg in ('nudge', 'checkin'):
                        self.assertEqual(self.run_script(nutrition / 'watch_check.py', [arg]), 0)
                        self.assertEqual([r for r in self.rows() if r['name'] == 'watcher.run'][-1]['props']['trigger'], expected)
                    def fixture(g):
                        g['_sync'] = lambda *a, **kw: None
                    self.assertEqual(self.run_script(self.vault / 'whoop/whoop.py', ['sync'], fixture), 0)
                    self.assertEqual([r for r in self.rows() if r['name'] == 'sync.run'][-1]['props']['trigger'], expected)
            # OAuth backfill calls the Python sync function directly, as a chained tool.
            def callback(g):
                g['_sync'] = lambda *a, **kw: None
                g['main'] = lambda args: g['sync'](full=True, trigger='chained')
            self.assertEqual(self.run_script(self.vault / 'whoop/whoop.py', ['serve'], callback), 0)
            self.assertEqual([r for r in self.rows() if r['name'] == 'sync.run'][-1]['props']['trigger'], 'chained')
        finally:
            (nutrition / 'watch.off').unlink()

    def test_recovery_watcher_marks_its_child_sync_chained(self):
        vault = self.root / 'recovery-vault'
        (vault / 'whoop').mkdir(parents=True)
        cards = self.root / 'cards'
        cards.mkdir()
        result = self.root / 'child-trigger'
        (vault / 'whoop/whoop.py').write_text(
            'import os\nfrom pathlib import Path\nPath(os.environ["TRIGGER_RESULT"]).write_text(os.environ.get("HEALTH_TOOLLOG_TRIGGER", "unknown"))\n')
        db = vault / 'health.db'
        with sqlite3.connect(str(db)) as con:
            con.executescript('CREATE TABLE whoop_recovery(raw_json TEXT); CREATE TABLE whoop_sleep(raw_json TEXT);')
        env = dict(os.environ, VAULT_DIR=str(vault), CARDS_DIR=str(cards), WATCH_DIR=str(self.watch),
                   HEALTH_DB=str(db), NOW_DXB='2026-11-13T12:00', TRIGGER_RESULT=str(result),
                   HEALTH_TOOLLOG_TRIGGER='schedule')
        env.pop('NO_SYNC', None)
        run = subprocess.run(['/bin/zsh', str(PACKAGE / 'watchers/whoop-recovery-card/check.sh')],
                             env=env, capture_output=True, text=True, timeout=15)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(result.read_text(), 'chained')

    def test_forge_run_trigger(self):
        latest = self.root / 'forge.json'
        latest.write_text('{}')
        report = types.ModuleType('report')
        report.LATEST, report.last_change_ms = str(latest), lambda w: 0
        report.load_doc = lambda **kw: {'payload': {'workouts': []}}
        with mock.patch.dict(sys.modules, report=report):
            for value in ('schedule', 'manual', 'retry'):
                with mock.patch.dict(os.environ, HEALTH_TOOLLOG_TRIGGER=value):
                    self.assertEqual(self.run_script(PACKAGE / 'watchers/forge-workouts/check.py'), 0)
                    self.assertEqual([r for r in self.rows() if r['name'] == 'watcher.run'][-1]['props']['trigger'], value)

    def test_each_vault_cli_success_and_failure(self):
        if not self.vault.exists():
            self.skipTest('set HEALTH_VAULT_TEST_COPY to an instrumented throwaway vault')
        # Help exercises the real parsers, without reading health data or invoking renderers.
        for rel, component, good, bad in [
            ('nutrition/food.py', 'food', ['--help'], ['quick', 'PurpleDragonFixtureFood']),
            ('hlog.py', 'hlog', [], ['invalid-command']),
            ('whoop/whoop.py', 'whoop', ['status'], ['invalid-command']),
            ('cards/cards.py', 'cards', ['--help'], ['invalid-command'])]:
            for args, expected in [(good, 0), (bad, 1)]:
                with self.subTest(component=component, expected=expected):
                    status = self.run_script(self.vault / rel, args)
                    self.assertEqual(status, expected)
                    self.assert_run(component, status)

    def test_validate_success_and_failure(self):
        if not self.vault.exists():
            self.skipTest('set HEALTH_VAULT_TEST_COPY')
        # The original snapshot has unsynced confirmations and a VG/SQ site mismatch.
        # Build consistent test inputs from that snapshot; never change the snapshot DB.
        source_meds = self.vault.parent / 'home/.local/share/robob-watch/watchers/meds-nag'
        for path in source_meds.glob('*'):
            if path.is_file():
                shutil.copy2(path, self.watch / path.name)
        with sqlite3.connect(str(self.vault / 'health.db')) as con:
            aliases = {'Dutasteride': 'dutasteride', 'Tadalafil': 'tadalafil', 'Arimidex': 'arimidex',
                       'Retatrutide': 'reta', 'Testosterone Enanthate': 'test'}
            taken = {}
            for day, med in con.execute("SELECT date, compound FROM doses WHERE source='meds-nag' AND status='Taken'"):
                taken.setdefault(day, []).append(aliases[med])
            (self.watch / 'taken.json').write_text(json.dumps(taken))
            sites = {day: {'test': side[0]} for day, side in con.execute('SELECT date, site FROM injection_sites') if side.endswith('-VG')}
            (self.watch / 'sites.json').write_text(json.dumps(sites))
        status = self.run_script(self.vault / 'validate.py')
        self.assertEqual(status, 0)
        self.assert_run('validate', status)
        self.assertTrue(any(r['name'] == 'validate.conflicts' for r in self.rows()))
        status = self.run_script(self.vault / 'validate.py', patches=[mock.patch('sqlite3.connect', side_effect=sqlite3.OperationalError('private'))])
        self.assertEqual(status, 1)
        self.assert_run('validate', status)

    def test_took_success_failure_and_private_inputs(self):
        local = self.watch / 'took.py'
        shutil.copy2(PACKAGE / 'watchers/meds-nag/took.py', local)
        shutil.copy2(PACKAGE / 'watchers/meds-nag/check.py', self.watch / 'check.py')
        for args, expected in [(['2026-11-13', 'tadalafil'], 0), (['2026-11-13', 'test:bad'], 1)]:
            status = self.run_script(local, args)
            self.assertEqual(status, expected)
            self.assert_run('took', status)
        text = json.dumps(self.rows())
        self.assertNotIn('tadalafil', text)
        self.assertNotIn('test:bad', text)

    def test_took_preserves_live_site_label_forms(self):
        local = self.watch / 'took.py'
        shutil.copy2(PACKAGE / 'watchers/meds-nag/took.py', local)
        shutil.copy2(PACKAGE / 'watchers/meds-nag/check.py', self.watch / 'check.py')
        forms = ['test:L', 'test:R', 'test:L-VG', 'test:R-VG', 'test:L-SQ', 'test:R-SQ',
                 'test:l', 'test:r-vg', 'test:l-sq', 'all:R-SQ']
        for value in forms:
            with self.subTest(value=value):
                result = mock.Mock(stdout='fixture', stderr='')
                self.assertEqual(self.run_script(local, ['2026-11-13', value], patches=[
                    mock.patch('subprocess.run', return_value=result)]), 0)
                self.assert_run('took', 0)
        self.assertEqual(self.run_script(local, ['2026-11-13', 'test:invalid']), 1)
        self.assert_run('took', 1)

    def test_meds_watcher_sent_snoozed_stopped_and_failure(self):
        script = PACKAGE / 'watchers/meds-nag/check.py'
        self.assertEqual(self.run_script(script), 0)
        self.assertIn('nag.sent', [r['name'] for r in self.rows()])
        self.assertEqual(self.run_script(script), 0)
        self.assertIn('nag.snoozed', [r['name'] for r in self.rows()])
        (self.watch / 'taken.json').write_text(json.dumps({'2026-11-13': ['dutasteride', 'tadalafil', 'test', 'reta', 'arimidex']}))
        self.assertEqual(self.run_script(script), 0)
        self.assertIn('nag.stopped', [r['name'] for r in self.rows()])
        (self.watch / 'taken.json').write_text(json.dumps({'2026-11-13': 7}))
        self.assertEqual(self.run_script(script), 1)
        self.assert_run('meds-nag', 1, 'watcher.run')

    def test_meds_fold_logs_only_when_printed(self):
        script = PACKAGE / 'watchers/meds-nag/check.py'
        (self.watch / 'taken.json').write_text('{}')
        self.assertEqual(self.run_script(script, ['--fold']), 0)
        self.assertTrue(self.stdout.getvalue().startswith('💊 Still need: '))
        self.assertEqual([r['name'] for r in self.rows()].count('nag.folded'), 1)
        self.assertEqual(self.run_script(script, ['--fold']), 0)
        self.assertEqual(self.stdout.getvalue(), '')
        self.assertEqual([r['name'] for r in self.rows()].count('nag.folded'), 1)

    def test_gym_and_forge_watchers_success_and_failure(self):
        script = PACKAGE / 'watchers/gym-nudge/check.py'
        self.assertEqual(self.run_script(script), 0)
        self.assert_run('gym-nudge', 0, 'watcher.run')
        self.assertEqual(self.rows()[-1]['ok'], True)
        self.assertIn('nag.sent', [r['name'] for r in self.rows()])
        self.assertEqual(self.run_script(script), 0)
        self.assertIn('nag.snoozed', [r['name'] for r in self.rows()])
        (self.watch / 'last_fired').unlink()
        latest_gym = self.home / 'Library/Mobile Documents/iCloud~com~abdullah1738~forgeworkout/Documents/latest.json'
        latest_gym.parent.mkdir(parents=True)
        latest_gym.write_text(json.dumps({'workouts': [{'localDate': '2026-11-13'}]}))
        self.assertEqual(self.run_script(script), 0)
        self.assertIn('nag.stopped', [r['name'] for r in self.rows()])
        (self.watch / 'last_fired').unlink()
        (self.watch / 'last_fired').mkdir()
        self.assertEqual(self.run_script(script), 1)
        self.assert_run('gym-nudge', 1, 'watcher.run')
        latest = self.root / 'forge.json'
        latest.write_text('{}')
        report = types.ModuleType('report')
        report.LATEST, report.last_change_ms = str(latest), lambda w: 0
        report.load_doc = lambda **kw: {'payload': {'workouts': []}}
        with mock.patch.dict(sys.modules, report=report):
            script = PACKAGE / 'watchers/forge-workouts/check.py'
            self.assertEqual(self.run_script(script), 0)
            self.assert_run('forge-workouts', 0, 'watcher.run')
            latest.unlink()
            self.assertEqual(self.run_script(script), 1)
            self.assert_run('forge-workouts', 1, 'watcher.run')

    def test_nutrition_watchers_success_and_failure(self):
        if not self.vault.exists():
            self.skipTest('set HEALTH_VAULT_TEST_COPY')
        for kind, component in [('checkin', 'nutrition-checkin'), ('nudge', 'nutrition-nudge')]:
            self.assertEqual(self.run_script(self.vault / 'nutrition/watch_check.py', [kind]), 0)
            self.assert_run(component, 0, 'watcher.run')
            (self.watch / (kind + '.last')).unlink()
            (self.watch / (kind + '.last')).mkdir()
            self.assertEqual(self.run_script(self.vault / 'nutrition/watch_check.py', [kind]), 1)
            self.assert_run(component, 1, 'watcher.run')

    def test_nutrition_reminder_outcomes(self):
        if not self.vault.exists():
            self.skipTest('set HEALTH_VAULT_TEST_COPY')
        flag = None
        con = mock.Mock()
        con.execute.side_effect = lambda sql, args: mock.Mock(fetchone=lambda:
            {'meals': 0, 'kcal': 0, 'protein_g': 0} if 'daily_summary' in sql else flag)
        nlib = types.SimpleNamespace(now=lambda: dt.datetime(2026, 11, 13, 23), connect=lambda: con)
        stamp = self.watch / 'nudge.last'
        stamp.write_text('2026-11-12')
        with mock.patch.dict(sys.modules, nlib=nlib):
            self.assertEqual(self.run_script(self.vault / 'nutrition/watch_check.py', ['nudge']), 0)
            self.assertIn('nag.sent', [r['name'] for r in self.rows()])
            self.assertEqual(self.run_script(self.vault / 'nutrition/watch_check.py', ['nudge']), 0)
            self.assertIn('nag.snoozed', [r['name'] for r in self.rows()])
            stamp.write_text('2026-11-12')
            flag = {'completeness': 'complete'}
            self.assertEqual(self.run_script(self.vault / 'nutrition/watch_check.py', ['nudge']), 0)
            self.assertIn('nag.stopped', [r['name'] for r in self.rows()])

    def test_whoop_sync_success_refresh_pending_gap_and_failure(self):
        if not self.vault.exists():
            self.skipTest('set HEALTH_VAULT_TEST_COPY')
        def fixture(g):
            con = mock.MagicMock()
            def execute(sql, *args):
                row = ('2020-01-01', '2020-01-01') if 'min(sleep_date)' in sql else (0,)
                return mock.Mock(fetchone=lambda: row)
            con.execute.side_effect = execute
            g['db'] = lambda: con
            g['import_sleep'] = lambda *a: 2
            g['import_recovery'] = lambda *a: 1
            g['import_cycles'] = lambda *a: 3
            g['import_body'] = lambda *a: 1
            g['mirror_sleep_sessions'] = lambda *a: 0
            g['set_status'] = lambda **kw: None
            g['log'] = lambda *a: None
            g['TokenLock'] = contextlib.nullcontext
            g['load_tokens'] = lambda: {'expires_at': 0, 'refresh_token': 'private'}
            g['client_creds'] = lambda: ('private', 'private')
            g['token_request'] = lambda form: {}
            g['save_tokens'] = lambda *a, **kw: {'access_token': 'private', 'expires_at': 9999999999}
            def collection(path, start, diagnostic=None):
                g['valid_access_token']()
                return {'/activity/sleep': [{'end': '2020-01-01T00:00:00Z'}] * 2,
                        '/recovery': [{'score_state': 'PENDING_SCORE'}], '/cycle': [{}, {}, {}]}[path]
            g['collection'] = collection
            g['api_get'] = lambda *a, **kw: {'max_heart_rate': 200}
        script = self.vault / 'whoop/whoop.py'
        self.assertEqual(self.run_script(script, ['sync'], fixture), 0)
        self.assert_run('whoop-sync', 0, 'sync.run')
        row = [r for r in self.rows() if r['name'] == 'sync.run'][-1]
        self.assertTrue(row['props']['tokenRefreshed'])
        self.assertTrue(row['props']['notScoredYet'])
        self.assertIn('sync.gap', [r['name'] for r in self.rows()])
        def broken(g):
            def fail(*a, **kw):
                raise RuntimeError('PurpleDragonFixtureFood 31337.456mg 98765.432kg')
            g['_sync'] = fail
        self.assertEqual(self.run_script(script, ['sync'], broken), 1)
        self.assert_run('whoop-sync', 1, 'sync.run')
        self.assert_run('whoop', 1)

    def test_whoop_unscorable_is_not_pending(self):
        if not self.vault.exists():
            self.skipTest('set HEALTH_VAULT_TEST_COPY')
        cases = [(['SCORED'], False), (['PENDING_SCORE'], True),
                 (['UNSCORABLE'], False), ([], True), (['UNSCORABLE', 'SCORED'], False)]
        for states, expected in cases:
            def fixture(g):
                # Stop after real recovery-state accounting, before DB writes.
                def collection(path, start, diagnostic=None):
                    if path == '/cycle':
                        raise RuntimeError('fixture stop')
                    return [{'score_state': state} for state in states]
                g['collection'] = collection
            with self.subTest(states=states):
                self.assertEqual(self.run_script(self.vault / 'whoop/whoop.py', ['sync'], fixture), 1)
                row = [r for r in self.rows() if r['name'] == 'sync.run'][-1]
                self.assertEqual(row['props']['notScoredYet'], expected)

    def test_card_render_and_stale_brief_success_and_failure(self):
        if not self.vault.exists():
            self.skipTest('set HEALTH_VAULT_TEST_COPY')
        def fixture(g):
            g['whoop'] = lambda d: None
            g['card_recovery'] = lambda d, p: str(p)
            g['card_body'] = lambda d, p, take: str(p)
        script = self.vault / 'cards/cards.py'
        self.assertEqual(self.run_script(script, ['morning', '--date', '2020-01-01'], fixture), 0)
        self.assert_run('cards', 0, 'card.render')
        self.assertIn('brief.fresh', [r['name'] for r in self.rows()])
        def broken(g):
            import subprocess
            def render():
                raise subprocess.CalledProcessError(1, 'renderer', stderr='private')
            g['card_nutrition'] = lambda *a: render()
        self.assertEqual(self.run_script(script, ['nutrition'], broken), 1)
        self.assert_run('cards', 1, 'card.render')
        self.assertEqual([r for r in self.rows() if r['name'] == 'card.render'][-1]['error']['tag'], 'renderer_failed')

    def test_card_argument_shapes(self):
        if not self.vault.exists():
            self.skipTest('set HEALTH_VAULT_TEST_COPY')
        def fixture(g):
            g['whoop'] = lambda d: None
            g['card_recovery'] = lambda d, p: str(p)
            g['card_body'] = lambda d, p, take: str(p)
            g['card_nutrition'] = lambda d, p: str(p)
        cases = [
            (['nutrition'], 0, 'nutrition'),
            (['--date', '2020-01-01', 'nutrition'], 0, 'nutrition'),
            (['nutrition', '--date', '2020-01-01'], 0, 'nutrition'),
            (['--out', str(self.root), '--date', '2020-01-01', 'morning'], 0, 'morning'),
            (['--take', 'nutrition', '--date', '2020-01-01', 'morning'], 0, 'morning'),
            (['morning', '--take', 'PurpleDragonFixtureFood', '--date', '2020-01-01'], 0, 'morning'),
            ([], 1, None), (['invalid-kind'], 1, None),
            (['--help'], 0, None), (['nutrition', '--date'], 1, None),
            (['--date', '2020-01-01', '--help'], 0, None),
        ]
        for args, status, kind in cases:
            with self.subTest(args=args):
                before = len([r for r in self.rows() if r['name'] == 'card.render'])
                self.assertEqual(self.run_script(self.vault / 'cards/cards.py', args, fixture), status)
                rendered = [r for r in self.rows() if r['name'] == 'card.render'][before:]
                self.assertEqual(len(rendered), int(kind is not None))
                if kind:
                    self.assertEqual(rendered[0]['props']['kind'], kind)
                    cli = [r for r in self.rows() if r['name'] == 'cli.run'][-1]
                    self.assertEqual(cli['props']['subcommand'], kind)

    def test_rollup_cli_success_and_missing_day(self):
        if not self.vault.exists():
            self.skipTest('set HEALTH_VAULT_TEST_COPY')
        toollog.emit('food', 'cli.run', ok=True)
        day = toollog.utcnow().date().isoformat()
        script = self.vault / 'toollog_rollup.py'
        self.assertEqual(self.run_script(script, ['--day', day]), 0)
        self.assert_run('rollup', 0, 'rollup.run')
        self.assertEqual(self.run_script(script, ['--day', '2000-01-01']), 0)
        self.assert_run('rollup', 1, 'rollup.run')


if __name__ == '__main__':
    unittest.main()

"""Size overrides are decided before detaching and remain visible while queued or settled."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import cli, common, lease, misc, runs
from test_capacity import Isolated
import test_bg_queue_detach as detach


class SizeSubmissionTests(Isolated):
    def args(self, size=None, cmd='true'):
        return SimpleNamespace(bg=True, no_sync=True, cmd=[cmd], steps=[], pull=[], env=[], size=size,
                               template=None, base=None, fresh=False, git=False)

    def test_background_notice_precedes_id_and_child_uses_frozen_size(self):
        for allow, expected in (('', 'large'), ('1', 'xlarge')):
            with self.subTest(allow=allow):
                root = Path(self.tmp.name)
                acquired = root / 'acquired-size'
                acquired.unlink(missing_ok=True)
                proc = subprocess.run([sys.executable, '-I', str(Path(detach.__file__).resolve()),
                                       '--fixture', str(root), '1', 'boat'],
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=15,
                                      env=dict(os.environ, OFFBOX_TEST_REQUESTED_SIZE='xlarge',
                                               OFFBOX_ALLOW_XLARGE=allow, OFFBOX_TEST_RETURN='1'))
                self.assertEqual(proc.returncode, 0, proc.stdout)
                rid = next(line for line in proc.stdout.splitlines() if line.startswith('run-'))
                row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (rid,)).fetchone()
                self.addCleanup(detach.BackgroundQueueTests.stop_child, self, row['client_pid'], -1)
                detach.BackgroundQueueTests.until(self, acquired.exists)
                self.assertEqual(acquired.read_text(), expected)
                self.assertEqual((row['requested_size'], row['size']), ('xlarge', expected))
                if allow:
                    self.assertNotIn('NOTE', proc.stdout)
                    self.assertEqual(row['size_note'], '')
                else:
                    note = f'offbox: NOTE run {rid} will run on large, not the --size xlarge you asked for:'
                    self.assertIn(note, proc.stdout)
                    self.assertLess(proc.stdout.index(note), proc.stdout.index('\n' + rid + '\n'))
                    self.assertLess(proc.stdout.index(note), proc.stdout.index('pending run '))
                    self.assertIn('OFFBOX_ALLOW_XLARGE=1 forces xlarge', row['size_note'])
                child_log = (root / 'LOGS_DIR' / f'{rid}.client.log').read_text()
                self.assertNotIn('NOTE', child_log)
                self.assertNotIn('child recomputed size', child_log)

    def test_auto_size_note_and_event_are_recorded_once(self):
        a = self.args(cmd='docker compose up')
        with patch.object(runs.os, 'getcwd', return_value=self.me['repo_root']), \
                contextlib.redirect_stderr(io.StringIO()):
            runner = runs.Runner(a, self.me)
            runner.register_pending()
            runner.register_pending()
        row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (runner.run_id,)).fetchone()
        self.assertIsNone(row['requested_size'])
        self.assertEqual(row['size'], 'xlarge')
        self.assertIn('container stack run', row['size_note'])
        events = self.con.execute("SELECT detail FROM events WHERE kind='size_override'").fetchall()
        self.assertEqual(len(events), 1)
        self.assertEqual(json.loads(events[0][0]), dict(run_id=runner.run_id, requested=None,
                                                     effective='xlarge', reason=row['size_note']))

    def test_foreground_registration_decides_before_pending_id(self):
        a = self.args('xlarge')
        a.bg = False
        err = io.StringIO()
        with patch.dict(os.environ, OFFBOX_ALLOW_XLARGE=''), \
                patch.object(runs.os, 'getcwd', return_value=self.me['repo_root']), \
                contextlib.redirect_stderr(err), patch.object(lease, 'auto_size', wraps=lease.auto_size) as decide:
            runner = runs.Runner(a, self.me)
            runner.register_pending()
            runner.register_pending()
        decide.assert_called_once()
        self.assertLess(err.getvalue().index('NOTE'), err.getvalue().index('pending run'))
        row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (runner.run_id,)).fetchone()
        self.assertEqual((row['requested_size'], row['size']), ('xlarge', 'large'))
        event = self.con.execute("SELECT detail FROM events WHERE kind='size_override'").fetchone()
        self.assertEqual(json.loads(event[0])['requested'], 'xlarge')

    def test_legacy_queued_size_decisions_are_recorded_once(self):
        cases = (
            ('xlarge', 'true', '1', 'xlarge', False),
            ('xlarge', 'true', '', 'large', True),
            ('large', 'true', '', 'large', False),
            (None, 'true', '', None, False),
            (None, 'docker compose up', '', 'xlarge', True),
        )
        for requested, cmd, allow, effective, has_note in cases:
            with self.subTest(requested=requested, cmd=cmd, allow=allow):
                rid = common.new_id('legacy')
                self.con.execute("INSERT INTO runs(run_id,mode,status,client_pid,local_cwd) "
                                 "VALUES (?,'bg','starting',?,?)", (rid, os.getpid(), self.me['repo_root']))
                err = io.StringIO()
                with patch.dict(os.environ, {runs.BACKGROUND_RUN_ENV: rid, 'OFFBOX_ALLOW_XLARGE': allow}), \
                        contextlib.redirect_stderr(err), patch.object(lease, 'auto_size', wraps=lease.auto_size) as decide:
                    runs.Runner(self.args(requested, cmd), self.me).register_pending()
                    runs.Runner(self.args(requested, cmd), self.me).register_pending()
                decide.assert_called_once()
                row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (rid,)).fetchone()
                self.assertEqual((row['requested_size'], row['size']), (requested, effective))
                self.assertEqual(bool(row['size_note']), has_note)
                self.assertIsNotNone(row['size_note'])
                self.assertEqual(err.getvalue().count('NOTE'), int(has_note))
                events = [json.loads(r[0]) for r in self.con.execute("SELECT detail FROM events WHERE kind='size_override'")]
                self.assertEqual(sum(e['run_id'] == rid for e in events), int(has_note))

    def test_saved_queued_decisions_survive_changed_policy_inputs(self):
        for requested, effective, note in ((None, None, ''), ('xlarge', 'xlarge', ''),
                                            ('xlarge', 'large', 'original downsize')):
            with self.subTest(requested=requested, effective=effective):
                rid = common.new_id('saved')
                self.con.execute("INSERT INTO runs(run_id,mode,status,client_pid,local_cwd,requested_size,size,size_note) "
                                 "VALUES (?,'bg','starting',?,?,?,?,?)",
                                 (rid, os.getpid(), self.me['repo_root'], requested, effective, note))
                with patch.dict(os.environ, {runs.BACKGROUND_RUN_ENV: rid, 'OFFBOX_ALLOW_XLARGE': '1'}), \
                        patch.object(lease, 'auto_size', side_effect=AssertionError('recomputed saved decision')), \
                        contextlib.redirect_stderr(io.StringIO()) as err:
                    a = self.args(requested)
                    runs.Runner(a, self.me).register_pending()
                self.assertEqual(a._size_decision, (effective, note))
                self.assertEqual(err.getvalue(), '')

    def test_existing_schema_migration_is_additive_and_idempotent(self):
        self.con.execute("INSERT INTO runs(run_id,cmd,size) VALUES ('old','true','large')")
        self.con.execute('ALTER TABLE runs ADD COLUMN unrelated TEXT')
        self.con.execute("UPDATE runs SET unrelated='keep'")
        for version in (6, 7, 8):
            with self.subTest(version=version):
                self.con.execute('ALTER TABLE runs DROP COLUMN requested_size')
                self.con.execute('ALTER TABLE runs DROP COLUMN size_note')
                self.con.execute(f'PRAGMA user_version={version}')
                self.con.commit()
                for _ in range(2):
                    with contextlib.closing(common.db()) as con:
                        common.ensure_schema(con)
                        self.assertEqual(con.execute('PRAGMA user_version').fetchone()[0], common.SCHEMA_VERSION)
                        row = con.execute("SELECT * FROM runs WHERE run_id='old'").fetchone()
                        self.assertEqual((row['cmd'], row['size'], row['unrelated']), ('true', 'large', 'keep'))
                        self.assertIsNone(row['requested_size'])
                        self.assertIsNone(row['size_note'])
                        with common.write(con):
                            common._migrate(con)

    def test_status_routes_full_and_suffix_ids_to_the_runs_backend(self):
        with patch.object(common, 'backend_pinned', return_value=None), \
                patch.object(common, 'home_config', return_value={'enabled': True}), \
                patch.object(common, 'default_backend', return_value='server'), \
                patch.object(common, '_known', side_effect=lambda backend, ident, suffix:
                             backend == 'boat' and (ident == 'run-size' or suffix and ident == 'size')):
            for ident in ('run-size', 'size'):
                self.assertEqual(common.entry_backend(['status', ident]), 'boat')
            self.assertEqual(common.entry_backend(['status']), 'server')

    def test_summary_database_failure_does_not_replace_known_exit(self):
        import sqlite3
        row = dict(run_id='run-size', status='done', exit_code=17, box_id=None,
                   requested_size='xlarge', size='large')
        with patch.object(misc, '_run_row', return_value=row), \
                patch.object(misc, '_settled', return_value=17), \
                patch.object(misc, 'db', side_effect=sqlite3.OperationalError('disk I/O error')), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.wait('run-size', None, summary=True), 17)

    def test_size_renderer_only_reports_different_explicit_sizes(self):
        for requested, effective, expected in (
                ('xlarge', 'large', 'size: large (asked xlarge; OFFBOX_ALLOW_XLARGE=1 keeps xlarge)'),
                ('large', 'xlarge', 'size: xlarge (asked large)'),
                ('xlarge', 'xlarge', ''), (None, 'xlarge', ''), ('xlarge', None, '')):
            with self.subTest(requested=requested, effective=effective):
                self.assertEqual(common.size_summary(dict(requested_size=requested, size=effective)), expected)
        self.assertEqual(common.size_summary(dict(size='large')), '')
        self.assertEqual(common.size_summary({}), '')

    def test_status_wait_follow_and_summary_show_requested_size(self):
        self.con.execute("INSERT INTO runs(run_id,mode,status,size,requested_size,log_path) "
                         "VALUES ('run-size','bg','starting','large','xlarge','test.log')")
        for entry in ('status', 'wait', 'follow', 'summary'):
            with self.subTest(entry=entry), contextlib.ExitStack() as stack:
                output = io.StringIO()
                stack.enter_context(contextlib.redirect_stdout(output))
                stack.enter_context(contextlib.redirect_stderr(output))
                stack.enter_context(patch.object(misc, '_wait_locked', return_value=124))
                stack.enter_context(patch.object(misc, '_never_started', return_value=True))
                stack.enter_context(patch.object(misc, '_report_never_started', return_value=100))
                if entry == 'status':
                    misc.status(self.me, cli.parse_args(['status', 'run-size']).run_id)
                elif entry == 'wait':
                    misc.wait('run-size', 0)
                elif entry == 'follow':
                    misc.logs('run-size', True)
                else:
                    misc._wait_summary('run-size', 0, 0)
                self.assertIn('size: large (asked xlarge; OFFBOX_ALLOW_XLARGE=1 keeps xlarge)', output.getvalue())

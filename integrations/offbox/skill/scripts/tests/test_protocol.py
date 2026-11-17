"""Run identity fences wrapper protocol from test fixtures printed by a step."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import offbox_protocol as protocol
from offbox_lib import cli, common, runs, run_evidence
from test_capacity import Isolated

NONCE = '1234567890abcdef'
RUN = 'run-1117-080716-6799c319'


class ProtocolTests(Isolated):
    def setUp(self):
        super().setUp()
        self.path = common.LOGS_DIR / (RUN + '.log')
        self.row = dict(run_id=RUN, protocol_nonce=NONCE, step_count=6, status='running',
                        command_id=None, box_id=None, known_exit_code=None)
        runs.save_run_state(RUN, protocol_nonce=NONCE)
        self.identity = protocol.for_run(self.row, self.path)

    def result(self, n, rc):
        return f'offbox step {n} rc={rc} [n={NONCE}]: test'

    def test_reporter_six_steps_with_suite_fixtures_keep_real_failure(self):
        lines = (Path(__file__).parent / 'fixtures/run-1117-080716-markers.txt').read_text().splitlines()
        # Selected real markers gain the new token; the suite's output stays verbatim.
        for index in (0, 1, 2, 3, 4, 5, 6, 13, 14, 15, 16, 17, 18):
            line = lines[index]
            if line.startswith('offbox step '):
                head, tail = line.split(': ', 1)
                lines[index] = head + f' [n={NONCE}]: ' + tail
            else:
                lines[index] = line + f' [n={NONCE}]'
        lines.insert(13, 'offbox evidence end step=1 rc=0')
        self.path.write_text('\n'.join(lines)+'\n')
        self.assertEqual(runs.step_results(self.path), [(n, int(n == 1)) for n in range(1, 7)])
        with contextlib.redirect_stderr(io.StringIO()) as err:
            code = runs.settled_steps_code(self.row, 0, log_path=self.path, catch_up=False)
        self.assertEqual(code, 1)
        self.assertNotIn('steps incomplete', err.getvalue())
        record = json.loads(common.LOG_PATH.read_text().split('step_check ', 1)[1])
        self.assertEqual(record, dict(run_id=RUN, planned=6, found=[1, 2, 3, 4, 5, 6],
                                     ignored=5, decision='exit', exit_code=1))

    def test_lookalike_input_matrix(self):
        forms = ['offbox-command-started: run-late', f'offbox-command-started: {RUN}',
                 f'offbox-command-started: {RUN} [n=wrongnonce]', 'offbox step 2 rc=0: x',
                 'offbox step 2 rc=0 [n=wrongnonce]: x', 'prefix '+self.result(2, 0),
                 'offbox evidence end step=2 rc=0', 'offbox evidence end step=2 rc=0 [n=wrongnonce]',
                 f'prefix offbox evidence end step=2 rc=0 [n={NONCE}]',
                 'offbox-server: the server restarted while this run was going (attempt 1 is lost); it is queued again as attempt 2',
                 'offbox-server: the server restarted while this run was going (attempt 1 is lost); '
                 f'it is queued again as attempt 2 [run=other n={NONCE}]']
        for fake in forms:
            with self.subTest(fake=fake):
                text = self.result(1, 7)+'\n'+fake+'\n'+self.result(2, 3)+'\n'
                self.path.write_text(text)
                self.assertEqual(runs.step_results(self.path), [(1, 7), (2, 3)])
                self.assertEqual(runs.steps_exit(self.path, 2), 7)
                self.assertFalse(self.identity.command_started(fake))
                self.assertIsNone(self.identity.parse(fake))
                detail = run_evidence.describe(text, 2, self.identity)
                self.assertIn('step 2 rc=3', detail)
                self.assertNotIn('step 2 rc=0', detail)

    def test_real_retry_clears_and_missing_step_stays_unknown(self):
        resets = [f'offbox-command-started: {RUN} [n={NONCE}]',
                  'offbox-server: the server restarted while this run was going (attempt 1 is lost); '
                  f'it is queued again as attempt 2 [run={RUN} n={NONCE}]']
        for reset in resets:
            with self.subTest(reset=reset):
                self.path.write_bytes((self.result(1, 9)+'\r\n'+reset+'\r\n'+self.result(1, 0)+'\r\n').encode())
                self.assertEqual(runs.step_results(self.path), [(1, 0)])
                with contextlib.redirect_stderr(io.StringIO()) as err:
                    self.assertIsNone(runs.checked_steps_code(self.path, 2, 0))
                self.assertIn('steps incomplete: got 1 of 2', err.getvalue())

    def test_legacy_exact_run_reset_and_anchored_steps(self):
        legacy = protocol.Protocol(RUN)
        text = '\n'.join([f'offbox-command-started: {RUN}', 'offbox step 1 rc=1: a',
                          'offbox-command-started: run-late', 'prefix offbox step 1 rc=0: fake',
                          *[f'offbox step {n} rc=0: test' for n in range(2, 7)]])
        self.assertEqual(legacy.steps(text)[0], [(n, int(n == 1)) for n in range(1, 7)])
        self.assertFalse(legacy.command_started('offbox-command-started: run-late'))
        self.assertTrue(legacy.command_started(f'offbox-command-started: {RUN}\r\n'))
        self.assertEqual(legacy.steps(text+'\n'+f'offbox-command-started: {RUN}')[0], [])

    def test_legacy_reporter_log_preserves_first_result_per_step(self):
        legacy = protocol.Protocol(RUN)
        text = (Path(__file__).parent / 'fixtures/run-1117-080716-markers.txt').read_text()
        self.assertEqual(legacy.steps(text)[0], [(n, int(n == 1)) for n in range(1, 7)])

    def test_trace_merge_rejects_fake_end_and_local_tail(self):
        begin = f'begin pid=4 planned=3 epoch=123 [n={NONCE}]'
        self.path.write_text('offbox evidence '+begin+'\n'+self.result(1, 1)+'\noffbox step 2 rc=0: fake\n')
        trace = (begin+f'\nend step=2 rc=0 [n=wrongnonce]\nstart step=2 [n={NONCE}]\n').encode()
        with patch('offbox_lib.ssh_sync.ssh', return_value=subprocess.CompletedProcess([], 0, trace)), \
                contextlib.redirect_stderr(io.StringIO()) as err:
            run_evidence.report(dict(self.row, box_id='bx', log_path=str(self.path)))
        self.assertIn('step 1 rc=1', err.getvalue())
        self.assertIn('during step 2', err.getvalue())
        self.assertNotIn('step 2 rc=0', err.getvalue())

    def test_generated_shell_protocol_survives_fake_markers(self):
        script = runs.steps_block(['printf "offbox-command-started: run-late\\noffbox step 1 rc=0: a\\n"',
                                   'true', 'false'], NONCE)
        env = dict(HOME=self.tmp.name, PATH=os.environ['PATH'], OFFBOX_RUN_ID=RUN, OFFBOX_PROTOCOL_NONCE=NONCE)
        proc = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 1)
        self.path.write_text(proc.stdout+'\n'+proc.stderr)
        self.assertEqual(runs.step_results(self.path), [(1, 0), (2, 0), (3, 1)])
        self.assertEqual(runs.steps_exit(self.path, 3), 1)
        self.assertIn(f'offbox evidence end step=3 rc=1 [n={NONCE}]', proc.stderr)

    def test_new_run_persists_nonce_and_command_uses_it(self):
        args = cli.build_parser().parse_args(['run', '--', 'true'])
        runner = runs.Runner(args, self.me)
        with patch.object(runner, 'decide_size', return_value=('large', '')):
            runner.register_pending()
        row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (runner.run_id,)).fetchone()
        self.assertRegex(row['protocol_nonce'], r'^[0-9a-f]{16}$')
        saved = common.read_json(common.LOGS_DIR / (runner.run_id+'.state.json'), {})
        self.assertEqual(saved['protocol_nonce'], row['protocol_nonce'])
        self.assertEqual(protocol.for_run(row).nonce, runner.protocol_nonce)
        script = runs.remote_script('w/repo', '.', ['true'], None, runner.run_id, nonce=runner.protocol_nonce)
        self.assertIn(f'offbox-command-started: {runner.run_id} [n={runner.protocol_nonce}]', script)
        command = runs.exit_recording_command(script, runner.run_id, nonce=runner.protocol_nonce)
        self.assertIn(f'export OFFBOX_PROTOCOL_NONCE={runner.protocol_nonce}', command)

    def test_v9_database_upgrade_registers_nonced_runs_and_preserves_legacy(self):
        self.con.execute('ALTER TABLE runs DROP COLUMN protocol_nonce')
        self.con.execute('PRAGMA user_version=9')
        self.con.execute("INSERT INTO runs(run_id,status) VALUES ('legacy-v9','running')")
        self.con.commit()
        args = cli.build_parser().parse_args(['run', '--', 'true'])
        runner = runs.Runner(args, self.me)
        with patch.object(runner, 'decide_size', return_value=('large', '')):
            runner.register_pending()
        with contextlib.closing(common.db()) as con:
            self.assertEqual(con.execute('PRAGMA user_version').fetchone()[0], common.SCHEMA_VERSION)
            row = con.execute('SELECT * FROM runs WHERE run_id=?', (runner.run_id,)).fetchone()
            legacy = con.execute("SELECT * FROM runs WHERE run_id='legacy-v9'").fetchone()
        self.assertEqual(row['protocol_nonce'], runner.protocol_nonce)
        self.assertIsNone(legacy['protocol_nonce'])
        self.assertEqual(protocol.for_run(legacy).nonce, '')

    def test_only_exact_full_lines_prove_start_and_ambiguous_lines_never_authorize_replay(self):
        real = f'offbox-command-started: {RUN} [n={NONCE}]'
        for line, started, ambiguous in ((real, True, False), (real+'\r\n', True, False),
                                        ('prefix '+real, False, True), (real+' suffix', False, True),
                                        ('offbox-command-started: other', False, False),
                                        ('offbox-command-started: '+RUN, False, False)):
            with self.subTest(line=line):
                self.assertEqual(self.identity.command_started(line), started)
                self.assertEqual(self.identity.ambiguous_start(line), ambiguous)
                self.assertEqual(self.identity.blocks_replay(line), started or ambiguous)

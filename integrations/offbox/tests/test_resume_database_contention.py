"""Stopped-lease resume keeps network work outside SQLite transactions and fails locally."""
import contextlib
import io
from pathlib import Path
import sqlite3
import sys
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'skill/scripts'
sys.path[:0] = [str(SCRIPTS), str(SCRIPTS / 'tests')]
from offbox_lib import api, cli, common, fallback, identity, lease, pool, runs
from test_capacity import Isolated


class ResumeDatabaseContention(Isolated):
    def test_stopped_resume_database_failures_are_93_before_command_start(self):
        # Both writes after SSH readiness can be the first failing statement. A local API
        # bookkeeping error is also pre-command even though the machine may have resumed.
        for phase in ('resume_call', 'resume_event', 'lease_state'):
            with self.subTest(phase=phase), contextlib.ExitStack() as stack:
                bid = 'box-' + phase
                root = Path(self.tmp.name) / phase
                root.mkdir()
                me = dict(self.me, repo_key=phase, repo_root=str(root))
                self.box(bid, state='stopped', member=True)
                self.con.execute('UPDATE leases SET repo_key=? WHERE box_id=?', (phase, bid))
                self.con.execute('UPDATE pool_members SET pool_key=? WHERE box_id=?', (phase, bid))
                connection = []
                boundaries = []
                injected = []

                def busy(sql):
                    injected.append(sql)
                    error = sqlite3.OperationalError('database is locked')
                    error.add_note('local state SQL: ' + sql)
                    raise error

                def resume_db():
                    con = common.db()
                    execute = con.execute
                    def checked(sql, *args):
                        if phase == 'lease_state' and sql.startswith("UPDATE leases SET state='running', size=?"):
                            return busy(sql)
                        return execute(sql, *args)
                    con.execute = checked
                    connection.append(con)
                    return con

                def external(label):
                    boundaries.append(label)
                    self.assertFalse(connection[-1].in_transaction, label)
                    # A second writer must work while the simulated API/SSH operation runs.
                    with contextlib.closing(common.db()) as other:
                        common.kv_set(other, 'probe:' + phase, label)
                    if phase == 'resume_call' and label == 'resume':
                        busy('UPDATE start_requests SET outcome=? (inside resume API bookkeeping)')
                    return {'state':'ready','type':'large'}

                real_event = lease.event
                def event(con, box, kind, detail=''):
                    if phase == 'resume_event' and kind == 'lease_resume':
                        self.assertFalse(con.in_transaction)
                        return busy('INSERT INTO events VALUES (?,?,?,?) [lease_resume]')
                    return real_event(con, box, kind, detail)

                stack.enter_context(patch.object(identity, 'whoami', return_value=me))
                stack.enter_context(patch.object(pool, 'db', side_effect=resume_db))
                stack.enter_context(patch.object(lease, 'event', side_effect=event))
                stack.enter_context(patch.object(api, 'get', return_value={'state':'archived','type':'large'}))
                resume = stack.enter_context(patch.object(api, 'resume', side_effect=lambda *a, **k: external('resume')))
                stack.enter_context(patch.object(api, 'wait_state', side_effect=lambda *a, **k: external('wait_state')))
                setup = stack.enter_context(patch.object(lease.ssh_sync, 'setup', side_effect=lambda *a: external('ssh_setup')))
                stack.enter_context(patch.object(lease.ssh_sync, 'wait_ssh', side_effect=lambda *a: external('ssh_ready')))
                command = stack.enter_context(patch.object(api, 'cmd_start'))
                local = stack.enter_context(patch.object(fallback, 'run_local'))
                infra = stack.enter_context(patch.object(fallback, 'note_infra_failure'))
                stderr = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                self.assertEqual(cli.main(['run','--remote','--no-fallback','--','echo','ok']), 93)
                self.assertIn('nothing ran, safe to retry', stderr.getvalue())
                self.assertNotIn('remote run error', stderr.getvalue())
                self.assertTrue(injected)
                resume.assert_called_once()
                command.assert_not_called()
                local.assert_not_called()
                infra.assert_not_called()
                if phase == 'resume_call':
                    self.assertEqual(boundaries, ['resume'])
                    setup.assert_not_called()
                else:
                    self.assertEqual(boundaries, ['resume','wait_state','ssh_setup','ssh_ready'])
                    setup.assert_called_once()
                with common.file_lock('box-' + bid, timeout=0):
                    pass
                saved = self.con.execute('SELECT status,exit_code,process_id FROM runs WHERE repo_root=?',
                                         (str(root),)).fetchone()
                self.assertEqual(tuple(saved), ('local_error',93,None))

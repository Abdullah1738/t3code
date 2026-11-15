import fcntl
import io
import json
import shlex
import subprocess
from unittest.mock import patch, Mock

if __package__:
    from .test_boatd import Base, boatd
else:
    from test_boatd import Base, boatd


class TempPreflightTests(Base):
    def test_runner_records_each_attempt_before_streams_are_merged(self):
        disk = boatd.offbox_disk_space
        box = self.box()
        self.cmd(box)
        space = dict(tmp=dict(free_bytes=2*disk.GIB, size_bytes=8*disk.GIB, fstype='tmpfs'))
        def probe(phase):
            return (disk.MARKER+json.dumps(dict(phase=phase, space=space))+'\n').encode()
        def preflight(con, row, err):
            err.write(probe('server_start')+probe('start'))
            return 0

        for current_error in (False, True):
            with self.subTest(current_error=current_error):
                errors = iter((True, current_error))
                def run(*args, stdout, stderr, **kw):
                    stdout.write('\N{SNOWMAN}\n'.encode())
                    stdout.write(b'ENOSPC: write failed\n' if next(errors) else b'assertion failed\n')
                    # The failing command's finally block has restored free space.
                    stderr.write(probe('end'))
                    return Mock(wait=Mock(return_value=2))
                with patch.object(boatd, 'load_cfg'), patch.object(boatd, 'db', return_value=self.con), \
                        patch.object(boatd, 'admit', return_value=0), patch.object(boatd, 'disk_preflight', preflight), \
                        patch.object(boatd, 'ct_exec'), patch.object(boatd.subprocess, 'Popen', run), \
                        patch.object(boatd, 'read_cg', return_value={}), \
                        patch.object(boatd, 'cg_path', return_value=self.tmp/'cgroup'), \
                        patch.object(boatd, 'ct_running', return_value=False):
                    for attempt in (1, 2):
                        self.con.execute("UPDATE commands SET attempt=?,status='queued',started_at=NULL,ended_at=NULL,"
                                         "exit_code=NULL,signal=NULL,metrics=NULL", (attempt,))
                        self.assertEqual(boatd.run_cmd(box, 1001), 0)
                row = self.status(box, 1001)
                self.assertEqual(row['exit_code'], 2)
                expected = 'enospc' if current_error else None
                self.assertEqual(json.loads(row['metrics'])['infra_failure'], expected)
                d = boatd.cmd_dir(box)
                summary = json.loads((d/'1001.err').read_text().splitlines()[-1][len(disk.MARKER):])
                self.assertEqual((summary['phase'], summary['attempt']), ('result', 2))
                for parts in (('out', 'err'), ('err', 'out')):
                    merged = self.tmp/'merged.log'
                    merged.write_bytes(b''.join((d/f'1001.{part}').read_bytes() for part in parts))
                    self.assertEqual(disk.result(merged, 2)['infra_failure'], expected)

    def test_admission_lock_live_context_and_dual_logging(self):
        box = self.box()
        self.cmd(box)
        self.cmd(box, pid=1002, status='queued')
        self.con.execute("UPDATE commands SET run_id='own' WHERE pid=1001")
        self.con.execute("UPDATE commands SET run_id='live' WHERE pid=1002")
        err = io.BytesIO()
        messages = []

        def probe(bid, command, **kw):
            self.assertEqual(bid, box)
            context = json.loads(shlex.split(command)[-1])
            self.assertEqual([r['run_id'] for r in context['live']], ['live'])
            with open(boatd.ADMIT_LOCK, 'w') as lock:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return subprocess.CompletedProcess([], 90, b'offbox: reclaimed /tmp/old (10 bytes)\n', b'gate refused\n')

        with patch.object(boatd, 'ct_exec', probe), patch.object(boatd, 'log', messages.append):
            code = boatd.disk_preflight(self.con, self.status(box, 1001), err)
        self.assertEqual(code, 90)
        self.assertIn(b'offbox: reclaimed', err.getvalue())
        self.assertTrue(any('own' in m and 'reclaimed' in m for m in messages))

    def test_person_box_and_non_run_commands_do_not_reap(self):
        box = self.box(owner='moni')
        self.cmd(box)
        with patch.object(boatd, 'ct_exec') as probe:
            self.assertEqual(boatd.disk_preflight(self.con, self.status(box, 1001), io.BytesIO()), 0)
            self.con.execute("UPDATE commands SET run_id='run-person'")
            with patch.dict(boatd.CFG, person_owners=['moni']):
                self.assertEqual(boatd.disk_preflight(self.con, self.status(box, 1001), io.BytesIO()), 0)
            probe.assert_not_called()

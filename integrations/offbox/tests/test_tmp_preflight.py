import fcntl
import io
import json
import shlex
import subprocess
from unittest.mock import patch

if __package__:
    from .test_boatd import Base, boatd
else:
    from test_boatd import Base, boatd


class TempPreflightTests(Base):
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

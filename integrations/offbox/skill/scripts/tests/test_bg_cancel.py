"""An unrelated signal, stale client identity, or old request must not cancel an accepted queue client."""
import contextlib
import io
import json
import os
from pathlib import Path
import signal
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import bg_cancel, common, queue_lifecycle
from test_capacity import Isolated


class CancellationTests(Isolated):
    def setUp(self):
        super().setUp()
        self.rid = 'run-cancellation'
        self.capability = bg_cancel.token()
        self.row = dict(run_id=self.rid, client_pid=os.getpid())

    def test_only_current_client_request_authorizes_pre_start_signal(self):
        bg_cancel.publish(self.rid, os.getpid(), self.capability)
        for content in (None, 'bad json', '[]', '{}',
                        json.dumps(dict(pid=os.getpid()+1, token=self.capability)),
                        json.dumps(dict(pid=os.getpid(), token=bg_cancel.token()))):
            with self.subTest(content=content), bg_cancel.client(self.rid, self.capability), \
                    contextlib.redirect_stderr(io.StringIO()), patch.object(queue_lifecycle, 'received') as received:
                if content is not None:
                    (common.LOGS_DIR / f'{self.rid}.cancel.json').write_text(content)
                self.assertFalse(bg_cancel.interrupt(self.rid, signal.SIGTERM))
                received.assert_not_called()
        bg_cancel.request(self.row)
        with bg_cancel.client(self.rid, self.capability), contextlib.redirect_stderr(io.StringIO()), \
                patch.object(queue_lifecycle, 'received') as received:
            self.assertTrue(bg_cancel.interrupt(self.rid, signal.SIGTERM))
            received.assert_called_once_with(self.rid, signal.SIGTERM)

    def test_replacement_client_rejects_old_request(self):
        bg_cancel.publish(self.rid, os.getpid(), self.capability)
        bg_cancel.request(self.row)
        with bg_cancel.client(self.rid, bg_cancel.token()), contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(bg_cancel.interrupt(self.rid, signal.SIGTERM))

    def test_publication_must_match_kill_target(self):
        for identity in (dict(pid=os.getpid()+1, token=self.capability),
                         dict(pid=os.getpid(), token=''), ['invalid']):
            with self.subTest(identity=identity):
                common.atomic_write_json(common.LOGS_DIR / f'{self.rid}.client.json', identity)
                with self.assertRaisesRegex(common.OffboxError, 'identity changed'):
                    bg_cancel.request(self.row)
                self.assertFalse((common.LOGS_DIR / f'{self.rid}.cancel.json').exists())

    def test_started_and_legacy_clients_keep_existing_signal_path(self):
        for capability, started in ((None, False), (self.capability, True)):
            with self.subTest(capability=capability, started=started), bg_cancel.client(self.rid, capability), \
                    patch.object(queue_lifecycle, 'received') as received:
                self.assertTrue(bg_cancel.interrupt(self.rid, signal.SIGTERM, started=started))
                received.assert_called_once_with(self.rid, signal.SIGTERM)
        bg_cancel.request(self.row)  # No client metadata: an accepted pre-release client.
        self.assertFalse((common.LOGS_DIR / f'{self.rid}.cancel.json').exists())

    def test_ignored_signal_does_not_mislabel_a_later_exception(self):
        with bg_cancel.client(self.rid, self.capability), contextlib.redirect_stderr(io.StringIO()), \
                patch.object(queue_lifecycle.atexit, 'register'):
            with queue_lifecycle.client(self.rid):
                self.assertFalse(bg_cancel.interrupt(self.rid, signal.SIGTERM))
                details = queue_lifecycle.failed(self.rid, ValueError('later failure'))
                self.assertEqual(details, dict(errorClass='ValueError'))

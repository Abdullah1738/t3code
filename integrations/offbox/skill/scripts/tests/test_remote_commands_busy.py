"""Remote command state fences pool reuse even when the local run row has settled."""
import unittest
import contextlib
import io
from unittest.mock import Mock, patch
from offbox_lib import api, common, lease, pool, unfit
from tests.test_capacity import Isolated


class RemoteCommandsBusy(unittest.TestCase):
    def test_home_guard_fails_closed_for_busy_unknown_and_transport_errors(self):
        with patch.object(api,'BACKEND','server'):
            for response, expected in (({'busy':False},False),({'busy':True},True),({},True),(None,True)):
                with self.subTest(response=response), patch.object(api,'call',return_value=response):
                    self.assertEqual(lease.remote_commands_busy('bx_a'),expected)
            with patch.object(api,'call',side_effect=common.OffboxError('Incus is shutting down')):
                self.assertTrue(lease.remote_commands_busy('bx_a'))
            for status, code, busy in ((404, 'sandbox_not_found', False), (404, 'route_not_found', True),
                                       (403, 'forbidden', True), (500, 'incus_failed', True)):
                with self.subTest(status=status, code=code), \
                        patch.object(api, 'call', side_effect=api.ApiError(status, code, 'test')):
                    self.assertEqual(lease.remote_commands_busy('bx_a'), busy)

    def test_reuse_cannot_hand_out_busy_box(self):
        con=Mock()
        # Set-aside checks read kv first; refusal must precede lease reads or writes.
        with patch.object(lease,'boot_dead',return_value=None), patch.object(unfit,'available',return_value=True), patch.object(lease,'check_deletion'), \
                patch.object(api,'BACKEND','server'), patch.object(api,'call',return_value={'busy':True}):
            self.assertIsNone(lease._reuse(con,{'box_id':'bx_a'},None))
        con.execute.assert_not_called()

    def test_boat_keeps_its_existing_guard(self):
        with patch.object(api,'BACKEND','boat'), patch.object(api,'call') as call:
            self.assertFalse(lease.remote_commands_busy('bx_a'))
        call.assert_not_called()


class MissingPoolBox(Isolated):
    def test_confirmed_missing_box_is_retired_and_its_full_pool_slot_replaced(self):
        self.box('bx_missing', state='stopped', member=True, used=500)
        self.box('bx_busy', member=True)
        self.busy('bx_busy')
        def fresh(me, size, template, base, fresh):
            self.box('bx_replacement', member=True)
            return dict(self.con.execute("SELECT * FROM leases WHERE box_id='bx_replacement'").fetchone())
        with patch.object(api, 'BACKEND', 'server'), \
                patch.object(api, 'call', side_effect=api.ApiError(404, 'sandbox_not_found', 'no sandbox')), \
                patch.object(api, 'readiness_get', return_value=None), \
                patch.object(lease, 'acquire_private', side_effect=fresh) as create, \
                contextlib.redirect_stderr(io.StringIO()):
            row = pool.acquire(self.me)
            pool.release_guard(row)
        self.assertEqual(row['box_id'], 'bx_replacement')
        self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='bx_missing'").fetchone()[0], 'deleted')
        create.assert_called_once()

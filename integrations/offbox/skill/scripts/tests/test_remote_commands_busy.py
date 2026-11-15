"""Remote command state fences pool reuse even when the local run row has settled."""
import unittest
from unittest.mock import Mock, patch
from offbox_lib import api, common, lease


class RemoteCommandsBusy(unittest.TestCase):
    def test_home_guard_fails_closed_for_busy_unknown_and_transport_errors(self):
        with patch.object(api,'BACKEND','server'):
            for response, expected in (({'busy':False},False),({'busy':True},True),({},True),(None,True)):
                with self.subTest(response=response), patch.object(api,'call',return_value=response):
                    self.assertEqual(lease.remote_commands_busy('bx_a'),expected)
            with patch.object(api,'call',side_effect=common.OffboxError('Incus is shutting down')):
                self.assertTrue(lease.remote_commands_busy('bx_a'))

    def test_reuse_cannot_hand_out_busy_box(self):
        con=Mock()
        # boot_dead is a read-only set-aside check that runs before the busy guard; the guard must
        # refuse before any lease read or write.
        with patch.object(lease,'boot_dead',return_value=None), patch.object(lease,'check_deletion'), \
                patch.object(api,'BACKEND','server'), patch.object(api,'call',return_value={'busy':True}):
            self.assertIsNone(lease._reuse(con,{'box_id':'bx_a'},None))
        con.execute.assert_not_called()

    def test_boat_keeps_its_existing_guard(self):
        with patch.object(api,'BACKEND','boat'), patch.object(api,'call') as call:
            self.assertFalse(lease.remote_commands_busy('bx_a'))
        call.assert_not_called()

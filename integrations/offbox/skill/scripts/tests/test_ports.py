"""Offline tests: `offbox ports` forward and --reverse tunnels."""
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import cli, misc, ssh_sync  # noqa: E402


class TunnelArgsTests(unittest.TestCase):

    def popen_args(self, *a):
        with patch.object(ssh_sync.subprocess, 'Popen') as popen:
            ssh_sync.tunnel('bx_1', *a)
        return popen.call_args.args[0]

    def test_forward_maps_local_to_box(self):
        args = self.popen_args(9242, 50000)
        self.assertIn('-L', args)
        self.assertEqual(args[args.index('-L') + 1], '127.0.0.1:50000:127.0.0.1:9242')
        self.assertNotIn('-R', args)

    def test_reverse_maps_box_to_local_without_control_master(self):
        args = self.popen_args(1055, 61000, True)
        self.assertEqual(args[args.index('-R') + 1], '127.0.0.1:1055:127.0.0.1:61000')
        self.assertNotIn('-L', args)
        for opt in ('ExitOnForwardFailure=yes', 'ControlMaster=no', 'ControlPath=none'):
            self.assertIn(opt, args)
        self.assertEqual(args[-1], 'bx_1')


class PortsCommandTests(unittest.TestCase):

    def run_ports(self, argv):
        proc = MagicMock()
        proc.poll.side_effect = [None, 0]
        with patch.object(misc, 'resolve_box', return_value='bx_1'), \
             patch.object(misc.api, 'get', return_value={'state': 'running'}), \
             patch.object(misc.api, 'LIVE_STATES', ('running',)), \
             patch.object(misc.ssh_sync, 'setup'), \
             patch.object(misc.ssh_sync, 'tunnel', return_value=proc) as tunnel, \
             patch.object(misc.time, 'sleep'), \
             patch.object(misc.lease, 'touch') as touch, \
             patch.object(misc.lease, 'ensure_ttl') as ttl:
            misc.ports({}, *argv)
        return tunnel, touch, ttl

    def test_reverse_uses_given_local_port_and_keeps_lease_warm(self):
        tunnel, touch, ttl = self.run_ports((1055, 61000, None, True))
        tunnel.assert_called_once_with('bx_1', 1055, 61000, True)
        touch.assert_called_once_with('bx_1')
        ttl.assert_called_once()

    def test_reverse_without_local_reuses_remote_port_number(self):
        tunnel, _, _ = self.run_ports((1055, None, None, True))
        tunnel.assert_called_once_with('bx_1', 1055, 1055, True)

    def test_cli_parses_reverse(self):
        a = cli.build_parser().parse_args(['ports', '1055', '--local', '61000', '--reverse'])
        self.assertTrue(a.reverse)
        self.assertEqual((a.remote_port, a.local), (1055, 61000))
        self.assertFalse(cli.build_parser().parse_args(['ports', '3000']).reverse)


if __name__ == '__main__':
    unittest.main()

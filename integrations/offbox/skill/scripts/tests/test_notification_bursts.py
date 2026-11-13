"""Failure admission is per event; the bridge owns durable hourly aggregation."""
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import fallback, identity
import monitor_support


class Notifications(unittest.TestCase):
    def test_every_infra_failure_reaches_one_source_group_including_the_first(self):
        with patch.object(fallback, 'db'), patch.object(fallback, 'event'), \
                patch.object(fallback, 'telegram', return_value=True) as send:
            for i in range(12):
                fallback.note_infra_failure(f'failure {i}')
            self.assertEqual(send.call_count, 12)
            self.assertEqual(len({call.args[1] for call in send.call_args_list}), 12)
            self.assertTrue(all(call.kwargs['burst_key'] == 'infra' for call in send.call_args_list))
            self.assertIn('failure 0', send.call_args_list[0].args[0])
            self.assertIn('failure 11', send.call_args_list[-1].args[0])

    def test_cli_adapters_group_monitor_and_infra_but_leave_spending_alerts_alone(self):
        with patch.object(identity, 'log'), patch.object(identity.subprocess, 'run',
                return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertTrue(identity.telegram('failure', 'k', burst_key='infra'))
            self.assertEqual(run.call_args.args[0][-2:], ['--burst-key', 'infra'])
            self.assertTrue(identity.telegram('spend threshold', 'spend-k'))
            self.assertNotIn('--burst-key', run.call_args.args[0])
            self.assertTrue(monitor_support.telegram('session-test'))
            self.assertEqual(run.call_args.args[0][-2:], ['--burst-key', 'pressure'])

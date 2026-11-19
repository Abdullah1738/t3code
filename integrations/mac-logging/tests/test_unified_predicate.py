from collections import Counter
import datetime as dt
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import collector


class UnifiedPredicateTests(unittest.TestCase):
    def test_boot_type_prefilter_keeps_pmu_and_watchdog_clauses(self):
        run = Mock(return_value=SimpleNamespace(returncode=0, stdout='[]'))
        collector.unified(100, 1000, run)
        command = run.call_args.args[0]
        self.assertEqual(command[command.index('--predicate')+1],
            '(type == timesyncEvent AND eventMessage CONTAINS "=== system boot") OR '
            '(process == "kernel" AND eventMessage CONTAINS "PMU") OR '
            '(process == "watchdogd" AND eventMessage CONTAINS "unresponsive")')
        self.assertEqual(command[command.index('--style')+1], 'json')

    def test_timesync_boot_without_process_emits_original_boot_event(self):
        # Boot markers are Timesync records (PID 0), not kernel log messages.
        timestamp = '2020-10-21 13:36:47.000000-0400'
        at = dt.datetime(2020, 10, 21, 17, 36, 47, tzinfo=dt.timezone.utc).timestamp()
        row = dict(timestamp=timestamp, eventType='timesyncEvent', processID=0,
                   eventMessage='=== system boot: 7A33DF77-738A-4200-8B2B-E1ABD6287638')
        run = Mock(return_value=SimpleNamespace(returncode=0, stdout=json.dumps([row, row])))
        counts = collector.unified(at-1, at+1, run)
        self.assertEqual(counts, Counter({('restart', 'kernel', at): 1}))
        with patch.object(collector, 'emit') as emit:
            collector.crash_observations(counts)
        emit.assert_called_once_with('crashes', 'event', 'crash.observed', ok=True,
            props=dict(resourceKind='restart', process='kernel', count=1, observedAt=at))

    def test_pmu_and_watchdog_observations_keep_existing_classification(self):
        for process, message, expected in (
                ('kernel', 'PMU wdog', Counter({('hang', 'system'): 1})),
                ('kernel', 'PMU unresponsive', Counter({('hang', 'system'): 1})),
                ('kernel', 'PMU status', Counter()),
                ('watchdogd', 'service unresponsive', Counter({('hang', 'system'): 1}))):
            with self.subTest(process=process, message=message):
                row = dict(timestamp='1970-01-01 00:02:30.000000+0000',
                           eventType='logEvent', processImagePath='/usr/sbin/'+process,
                           eventMessage=message)
                run = Mock(return_value=SimpleNamespace(returncode=0, stdout=json.dumps([row])))
                self.assertEqual(collector.unified(100, 200, run), expected)


if __name__ == '__main__':
    unittest.main()

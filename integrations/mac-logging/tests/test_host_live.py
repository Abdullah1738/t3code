"""Opt-in read-only ABI checks on the real Mac; portable fixtures run offbox."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unittest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from host import Sampler
from host_native import Native


@unittest.skipUnless(sys.platform == 'darwin' and os.environ.get('MAC_HOST_LIVE_TEST') == '1', 'opt-in Mac ABI check')
class LiveHostTests(unittest.TestCase):
    def test_swap_load_and_1900_entry_state_pass(self):
        n = Native()
        sample = Sampler(n).tick()
        swap = subprocess.check_output(['/usr/sbin/sysctl', 'vm.swapusage'], text=True, timeout=5)
        used = float(re.search(r'used = ([\d.]+)M', swap)[1])*1024**2
        self.assertLess(abs(sample['swapUsedBytes']-used), 128*1024**2)
        uptime = subprocess.check_output(['/usr/bin/uptime'], text=True, timeout=5)
        loads = [float(x) for x in re.search(r'load averages?:\s*(.*)', uptime)[1].replace(',', ' ').split()]
        self.assertEqual(len(loads), 3)
        for actual, expected in zip(sample['load'], loads): self.assertLess(abs(actual-expected), 5)
        pids = n.pids()
        # Replay existing PIDs to measure 1,900 entries without spawning load.
        benchmark = n.states((pids*((1900+len(pids)-1)//len(pids)))[:1900])
        self.assertFalse(benchmark['stateScanTimedOut'])
        self.assertLess(benchmark['stateScanMs'], 2000)
        self.assertEqual(benchmark['stateProcessesRead']+benchmark['stateProcessesSkipped'], 1900)
        self.assertEqual(sample['errors'], [])
        self.assertGreater(sample['pageSize'], 0)
        self.assertGreater(sample['activePages'], 0)
        print(json.dumps(dict(sample=sample, swapCommand=swap.strip(), uptimeCommand=uptime.strip(),
                             state1900Benchmark=benchmark), sort_keys=True))

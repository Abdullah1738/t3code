import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import jobs


class RefreshFairnessTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def runner(self, clock, cost):
        def run(command, **kwargs):
            elapsed, rows = 0, []
            for child in command[2:]:
                duration = cost(Path(child))
                if elapsed+duration > kwargs['timeout']:
                    clock[0] += kwargs['timeout']
                    raise subprocess.TimeoutExpired(command, kwargs['timeout'], output=''.join(rows).encode())
                elapsed += duration
                rows.append('1\t'+child+'\n')
            clock[0] += elapsed
            return SimpleNamespace(returncode=0, stdout=''.join(rows), stderr='')
        return run

    def test_warm_partial_root_and_discovery_backlogs_do_not_starve_small_refresh(self):
        large, first, second, small = [self.root/name for name in ('partial','pending-a','pending-b','healthy')]
        roots = [large, first, second, small]
        for root, count in zip(roots, (917,512,512,1)):
            root.mkdir()
            for i in range(count):
                (root/('%04d'%i)).mkdir()
        healthy, unknown = small/'0000', large/'0916'
        # These four forms all lack an eligible cached timestamp. None may
        # turn the large root into the oldest refresh candidate by using zero.
        forms = ('limited','missing','invalid_at','future_at')
        for form in forms:
            with self.subTest(form=form),patch.dict(os.environ, TOOLLOG_DIR=str(self.root/('logs-'+form))):
                clock, now = [0], [1000000]
                cached = {str(child):dict(bytes=1024,at=now[0]-86400,attemptedAt=now[0]-86400,
                          partial=False,isDirectory=True) for child in large.iterdir()}
                cached[str(unknown)] = dict(attemptedAt=0,limited=True) if form=='limited' else (
                    {} if form=='missing' else dict(bytes=1024,at='invalid' if form=='invalid_at' else now[0]+7200))
                jobs.save_state('disk-inventory',dict(duMode='links',childState={str(large):cached,
                    str(small):{str(healthy):dict(bytes=1024,at=now[0]-86400,attemptedAt=now[0]-86400,
                                               partial=False,isDirectory=True)}}))
                run = self.runner(clock,lambda p:120 if p.parent in (first,second) or p==unknown else 3.4)
                with patch.object(jobs.time,'monotonic',side_effect=lambda:clock[0]), \
                     patch.object(jobs.time,'time',side_effect=lambda:now[0]):
                    for _ in range(12):
                        clock[0] = 0
                        jobs.directory_inventory(roots,run,deadline=150)
                        self.assertLessEqual(clock[0],150)
                        state = jobs.read_state('disk-inventory')
                        current = state['childState'][str(small)][str(healthy)]
                        self.assertEqual(current['at'],now[0])
                        self.assertFalse(current['partial'])
                        self.assertNotIn(str(small),state['partials'])
                        self.assertTrue(state['partials'][str(large)]['partial'])
                        now[0] += 86400
                self.assertTrue(any('bytes' not in value for cache in state['childState'].values() for value in cache.values()))

    def test_older_large_root_shares_refresh_budget_with_several_healthy_roots(self):
        large = self.root/'old-cache'
        healthy_roots = [self.root/('healthy%d'%i) for i in range(4)]
        pending_roots = [self.root/('pending%d'%i) for i in range(2)]
        roots = [large]+pending_roots+healthy_roots
        for root, count in zip(roots, (917,512,512,1,1,1,1)):
            root.mkdir()
            for i in range(count):
                (root/('%04d'%i)).mkdir()
        clock, now = [0], [1000000]
        with patch.dict(os.environ,TOOLLOG_DIR=str(self.root/'older-logs')):
            jobs.save_state('disk-inventory',dict(duMode='links',childState={str(root):{
                str(child):dict(bytes=1024,at=now[0]-(2*86400 if root==large else 86400),
                    attemptedAt=0,partial=False,isDirectory=True) for child in root.iterdir()}
                for root in [large]+healthy_roots}))
            run = self.runner(clock,lambda p:120 if p.parent in pending_roots else 3.4)
            with patch.object(jobs.time,'monotonic',side_effect=lambda:clock[0]), \
                 patch.object(jobs.time,'time',side_effect=lambda:now[0]):
                for _ in range(12):
                    clock[0] = 0
                    jobs.directory_inventory(roots,run,deadline=150)
                    self.assertLessEqual(clock[0],150)
                    state = jobs.read_state('disk-inventory')
                    for root in healthy_roots:
                        self.assertEqual(state['childState'][str(root)][str(root/'0000')]['at'],now[0])
                    self.assertTrue(any(v.get('at',0)>=1000000 for v in state['childState'][str(large)].values()))
                    now[0] += 86400

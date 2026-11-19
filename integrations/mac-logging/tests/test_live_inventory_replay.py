"""Replay the 14 Nov inventory shape; costs are explicit, not new Mac scans."""
import copy
import json
from pathlib import Path
import stat
from types import SimpleNamespace
from unittest.mock import patch

import test_deep_inventory as support

jobs, deep = support.jobs, support.deep


class LiveCostReplay(support.unittest.TestCase):
    setUp = support.DeepInventoryTests.setUp
    runner = support.DeepInventoryTests.runner

    def test_thirteen_roots_complete_with_live_counts_and_timeout_classes(self):
        # Counts: disk.deep.root 07:06Z; t3code/board counts updated by the
        # 08:37 hourly inventory. The five 600s failures and 139s truncated
        # scan are from the 06:21-07:06 pass. board median 3.4s: #26 diag.
        counts = [('wt',66), ('t3code-wt',287), ('board-wt',934), ('coord-wt',129),
                  ('tmp',3091), ('share',83), ('robob',87), ('LibraryCaches',255),
                  ('cache',28), ('caches',4), ('backup',2), ('data',5), ('data-v2',14)]
        roots = [Path('/replay')/name for name, _ in counts]
        topology = {r:[r/('%04d'%i) for i in range(n)] for r, (_, n) in zip(roots, counts)}
        giants = {topology[roots[i]][0] for i in (0,1,2,3,4,9)}
        for p in sorted(giants):
            topology[p] = [p/('part%d'%i) for i in range(3)]
        denied = set(topology[roots[1]][1:13]+topology[roots[2]][1:22]+topology[roots[3]][1:10])
        costs = {p:(3.4 if r == roots[2] else .034 if r == roots[4] else
                    1.5 if r in roots[:4] else .005) for r in roots for p in topology[r]}
        costs.update({p:139 if p.parent == roots[4] else 700 for p in giants})
        costs.update({part:180 for p in giants for part in topology[p]})
        # A genuine full 600s leaf timeout on night 1, followed by recovery.
        stuck = topology[topology[roots[9]][0]][0]
        failures = [0]
        timeout_cutoffs = []
        stored, events = {}, []
        def listing(path, deadline, source_failures=None):
            return [SimpleNamespace(path=str(p), is_dir=lambda **kw:True) for p in topology[Path(path)]], True
        def run(cmd, **kw):
            rows, stderr, elapsed = [], [], 0
            for key in cmd[2:]:
                p = Path(key)
                cost = 700 if p == stuck and failures[0] == 0 else costs[p]
                if elapsed+cost > kw['timeout']:
                    self.clock[0] += kw['timeout']
                    timeout_cutoffs.append(round(kw['timeout'], 3))
                    if p == stuck and kw['timeout'] >= 600:
                        failures[0] += 1
                    raise support.subprocess.TimeoutExpired(cmd, kw['timeout'], output=''.join(rows), stderr='\n'.join(stderr))
                elapsed += cost
                rows.append('1\t'+key+'\n')
                if p in denied:
                    stderr.append('du: '+key+'/private: Permission denied')
            self.clock[0] += elapsed
            return SimpleNamespace(returncode=int(bool(stderr)), stdout=''.join(rows), stderr='\n'.join(stderr))
        def save(name, value):
            stored[name] = value
        def emit(*args, **kwargs):
            events.append((args[2], kwargs.get('props', {})))
        results = []
        # Preserve the known slow-child hints present after old hourly runs.
        stored['disk-inventory'] = dict(duMode='links', childState={str(r):{
            str(p):dict(slow=True,limited=True,partial=True) for p in topology[r] if p in giants} for r in roots})
        with patch.object(jobs,'inventory_listing',side_effect=listing), \
             patch.object(jobs.os,'lstat',return_value=SimpleNamespace(st_mode=stat.S_IFDIR,st_blocks=0)), \
             patch.object(jobs.Path,'stat',return_value=SimpleNamespace(st_mode=stat.S_IFDIR,st_blocks=0)), \
             patch.object(jobs,'read_state',side_effect=lambda name:copy.deepcopy(stored.get(name,{}))), \
             patch.object(jobs,'save_state',side_effect=save), \
             patch.object(jobs,'emit',side_effect=emit),patch.object(deep,'emit',side_effect=emit):
            for night in range(3):
                self.clock[0] = night*86400
                start = self.clock[0]
                deep.run_pass(roots, run)
                state = stored['disk-inventory']
                complete = 13-sum(not v.get('completeWithDenied') for v in state['partials'].values())
                results.append(dict(night=night+1, seconds=round(self.clock[0]-start,3), rootsComplete=complete,
                                    rootsCompleteWithDenied=sum(v.get('completeWithDenied',False) for v in state['partials'].values()),
                                    remaining=next(p['childrenRemaining'] for n,p in reversed(events) if n=='disk.deep.end')))
                self.assertLessEqual(self.clock[0]-start, deep.BUDGET_S)
                end = next(p for n,p in reversed(events) if n=='disk.deep.end')
                self.assertAlmostEqual(sum(end['secondsByRoot'].values()), self.clock[0]-start, places=4)
                if complete == 13:
                    break
                for hour in range(2,24):
                    self.clock[0] = night*86400+hour*3600
                    jobs.directory_inventory(roots,run)
        print('LIVE_COST_REPLAY',json.dumps(dict(children=sum(n for _,n in counts), deniedChildren=len(denied),
              observedTimeoutCutoffsS=sorted(set(timeout_cutoffs)), directChildCostsS=[139,700], nights=results),sort_keys=True))
        self.assertEqual(complete,13)
        self.assertEqual(results[-1]['remaining'],0)
        self.assertEqual(failures[0],1)
        self.assertIn(600,timeout_cutoffs)
        self.assertEqual(len(denied),42)

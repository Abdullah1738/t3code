"""Sampled births and runnable threads. No subprocesses, argv or environment in output."""
from collections import Counter, deque
import re
import threading
import time

from cpu_labels import spawn_family

BUCKETS = ('pri<=4', '5-19', '20-31', '32-46', '47+')
METHOD = 'proc_listallpids+pid_start_snapshot_delta'


def bucket(priority):
    return BUCKETS[sum(priority > edge for edge in (4, 19, 31, 46))]


def identity(row):
    return row['pid'], tuple(row['start'])


def offbox_class(argv):
    from host import python_label
    if not argv or not re.fullmatch(r'(?i)python(?:\d+(?:\.\d+)*)?', argv[0].split('/')[-1]):
        return None, None
    if python_label(argv) != 'python:offbox.py':
        return None, None
    # Locate the actual script, not a string inside -c/-m or a later argument.
    # Prefix validation excludes option values that happen to be named
    # offbox.py, such as `python -W offbox.py /a/offbox.py wait`.
    index = next(i for i, word in enumerate(argv) if word.split('/')[-1] == 'offbox.py'
                 and python_label(argv[:i+1]) == 'python:offbox.py')
    args = argv[index+1:]
    kind = args[0] if args and args[0] in ('wait', '_bg-queue', 'run') else 'other'
    run = next((a for a in args if re.fullmatch(r'run-\d{4}-\d{6}-[a-f0-9]{8}', a)), None)
    return kind, run


class SpawnSampler:
    def __init__(self, native, clock=time.monotonic, cpu=time.thread_time, budget=1.5, epoch=None):
        self.native, self.clock, self.cpu, self.budget = native, clock, cpu, budget
        self.previous = None
        self.tasks = {}
        self.labels = {}
        self.threads_enabled = True
        self.thread_limit = 300
        self.interval = 5
        self.epoch = time.time() if epoch is None else epoch
        self.last_tick = None

    def degrade(self, reason, wall_ms, cpu_pct):
        previous = self.thread_limit
        if previous > 1:
            self.thread_limit = max(1, previous//2)
        else:
            self.interval = 15
        return dict(reason=reason, wallMs=wall_ms, cpuPct=cpu_pct,
                    previousThreadLimit=previous, threadLimit=self.thread_limit,
                    intervalS=self.interval)

    def record_cost(self, wall, cpu):
        # A descheduled tick is not a whole minute of sampling cost. Use actual
        # minute totals, plus the hard tick bound and measured CPU share.
        if wall >= self.budget or cpu > .02*self.interval:
            return self.degrade('tick_wall' if wall >= self.budget else 'tick_cpu',
                                wall*1000, cpu/self.interval*100)

    def phase(self, name):
        now, cpu = self.clock(), self.cpu()
        if self.phase_name is not None:
            self.phase_costs[self.phase_name] = dict(wallMs=(now-self.phase_wall)*1000,
                                                    cpuMs=(cpu-self.phase_cpu)*1000)
        self.phase_name, self.phase_wall, self.phase_cpu = name, now, cpu

    def tick(self):
        started, cpu_start = self.clock(), self.cpu()
        self.phase_costs = {}
        self.phase_name = None
        self.phase('identity')
        try:
            result = self._tick()
        except (OSError, ValueError):
            result = dict(at=started, partial=True, partialReasons=['inventory_unavailable'])
        self.phase(None)
        wall, cpu = self.clock()-started, self.cpu()-cpu_start
        action = self.record_cost(wall, cpu)
        result.update(wallMs=wall*1000, cpuMs=cpu*1000,
                      phaseCosts=self.phase_costs, guardActions=[action] if action else [],
                      intervalS=self.interval, threadsEnabled=True, threadLimit=self.thread_limit)
        return result

    def _tick(self):
        started = self.clock()
        deadline = started+self.budget
        reasons = set()
        def room(stage):
            if self.clock() >= deadline:
                reasons.add(stage+'_budget')
                return False
            return True
        pids = self.native.pids(deadline, self.clock)
        pid_set = set(pids)
        current, by_pid = {}, {}
        for pid in pids:
            if not room('identity'):
                break
            try:
                row = self.native.bsd(pid)
            except OSError:
                reasons.add('identity_unreadable')
                continue
            key = identity(row)
            current[key] = row
            by_pid[pid] = row
        old = self.previous or {}
        self.phase('parents')
        baseline = self.previous is None
        births = [r for k, r in current.items() if k not in old
                  and r['start'][0]+r['start'][1]/1e6 >= self.epoch] if not baseline else []
        # Only absence from the PID list (or a readable replacement) proves exit.
        exits = sum(k not in current and (k[0] not in pid_set or k[0] in by_pid) for k in old)
        retained = {k:r for k,r in old.items() if k not in current and k[0] in pid_set and k[0] not in by_pid}
        retained.update(current)
        self.previous = retained
        parents = {}
        for child in births:
            parent = by_pid.get(child['ppid'])
            if parent is None:
                parent = next((r for r in old.values() if r['pid'] == child['ppid']), None)
            if parent and tuple(parent['start']) > tuple(child['start']):
                parent = None
            key = (child['ppid'], tuple(parent['start']) if parent else None)
            entry = parents.setdefault(key, dict(ppid=key[0], parent_start=key[1],
                parent_comm=parent['comm'] if parent else 'unavailable', births=0, children=Counter(),
                family=self.labels.get(identity(parent), {}).get('family') if parent else None))
            entry['births'] += 1
            entry['children'][child['comm']] += 1
        self.phase('cpu')
        metrics, candidates = {}, []
        for key, row in current.items():
            if not room('cpu_offbox'):
                break
            try:
                task = self.native.task(row['pid'])
                # proc_pidinfo calls are not atomic; reject a reused PID.
                if not room('cpu_offbox'):
                    break
                if identity(self.native.bsd(row['pid'])) != key:
                    reasons.add('identity_changed')
                    continue
            except OSError:
                reasons.add('task_unreadable')
                continue
            previous = self.tasks.get(key)
            elapsed = started-previous[0] if previous else 0
            delta = task['cpuNs']-previous[1] if previous else None
            if delta is not None and delta < 0:
                delta = None
            pct = delta/1e9/elapsed*100 if delta is not None and elapsed > 0 else None
            metrics[key] = dict(task, cpuDeltaNs=delta, cpuPct=pct, cpuWindowS=elapsed or None)
            self.tasks[key] = (started, task['cpuNs'])
            # BSD SRUN also includes sleeping tasks. taskinfo.numrunning is
            # the native runnable-thread hint; CPU advancement catches races.
            if task['running'] > 0 or (delta is not None and delta > 0):
                candidates.append(key)
        self.tasks = {k:v for k,v in self.tasks.items() if k in retained}
        # Cache only derived allowlisted labels. Never retain raw argv or env.
        self.phase('argv')
        argv_started = self.clock()
        argv_reads = 0
        parent_pids = {p['ppid'] for p in parents.values()}
        # A busy host may never finish a cold argv census. Resolve the actors
        # this event names before spending that budget on unrelated daemons.
        pending = sorted(current.items(), key=lambda item:(
            item[1]['pid'] not in parent_pids,
            not item[1]['comm'].lower().startswith(('robob', 'codex', 'claude', 'python', 'bun', 'node')),
            item[1]['pid']))
        for key, row in pending:
            if key in self.labels:
                continue
            if argv_reads >= 32 or self.clock()-argv_started >= .05 or not room('argv'):
                break
            argv_reads += 1
            try:
                argv = self.native.argv(row['pid'])
                if not room('argv'):
                    break
                if identity(self.native.bsd(row['pid'])) != key:
                    reasons.add('identity_changed')
                    continue
                kind, run = offbox_class(argv)
                self.labels[key] = dict(kind=kind, run=run, family=spawn_family(argv, row['comm']))
            except (OSError, ValueError, UnicodeError):
                self.labels[key] = dict(kind='argv-unreadable', run=None, family=None)
        # Discard labels only after a confirmed exit, including PID reuse.
        self.labels = {k:v for k,v in self.labels.items() if k in retained}
        self.phase('offbox')
        classes = {k:dict(count=0, rssBytes=0, cpuDeltaNs=0, cpuUnknown=0, metricsUnreadable=0, cpuWindowMaxS=None, runs=set())
                   for k in ('wait', '_bg-queue', 'run', 'other', 'argv-unreadable', 'argv-pending')}
        for key in current:
            label = self.labels.get(key, dict(kind='argv-pending', run=None))
            kind = label['kind']
            if kind is None:
                continue
            entry = classes[kind]
            entry['count'] += 1
            task = metrics.get(key)
            if task:
                entry['rssBytes'] += task['rssBytes']
                entry['cpuDeltaNs'] += task['cpuDeltaNs'] or 0
                entry['cpuUnknown'] += task['cpuDeltaNs'] is None
                if task['cpuWindowS'] is not None:
                    entry['cpuWindowMaxS'] = max(entry['cpuWindowMaxS'] or 0, task['cpuWindowS'])
            else:
                entry['metricsUnreadable'] += 1
                entry['cpuUnknown'] += 1
            if label['run']:
                entry['runs'].add(label['run'])
        if classes['argv-pending']['count'] or classes['argv-unreadable']['count']:
            reasons.add('argv_coverage')
        for entry in classes.values():
            entry['distinctRunIds'] = len(entry.pop('runs'))
        counts = Counter(dict.fromkeys(BUCKETS, 0))
        top, covered, low, unknown = [], 0, 0, 0
        self.phase('threads')
        # Prioritize native runnable hints, then measured CPU gain. A small
        # pass survives overload instead of permanently latching the signal off.
        candidates.sort(key=lambda key:(metrics[key]['running'] <= 0,
            -(metrics[key]['cpuPct'] or 0), -(metrics[key]['cpuDeltaNs'] or 0), key))
        process_limit = min(300, self.thread_limit)
        thread_deadline = min(deadline, self.clock()+.05)
        for key in candidates[:process_limit]:
            if not room('threads') or self.clock() >= thread_deadline:
                reasons.add('threads_budget')
                break
            try:
                rows, complete = self.native.threads(key[0], thread_deadline, self.clock)
                if not room('threads'):
                    reasons.add('threads_budget')
                    break
                if not rows and not complete:
                    reasons.add('threads_incomplete')
                    continue
                # The 50ms allocation bounds thread reads. Validate any partial
                # rows against identity while the overall 1.5s budget remains.
                if identity(self.native.bsd(key[0])) != key:
                    reasons.add('threads_incomplete')
                    continue
            except OSError:
                reasons.add('threads_unreadable')
                continue
            local = Counter(bucket(curpri) for state, curpri, base in rows if state == 1)
            counts.update(local)
            covered += 1
            if not complete:
                reasons.add('threads_incomplete')
            if local:
                pct = metrics[key]['cpuPct']
                unknown += pct is None
                low += pct is not None and pct < .5
                top.append(dict(pid=key[0], start=key[1], comm=current[key]['comm'],
                    runnable=sum(local.values()), buckets=dict(local), cpuPct=pct))
        if covered < len(candidates):
            reasons.add('threads_coverage')
        sampled_threads = covered > 0 or (not candidates and len(metrics) == len(current) == len(pids)
                                         and (bool(current) or not pids))
        tick_window = started-self.last_tick if self.last_tick is not None else None
        self.last_tick = started
        return dict(at=started, births=len(births), exits=exits, baseline=baseline,
            parents=list(parents.values()), partial=bool(reasons), partialReasons=sorted(reasons),
            identityCovered=len(current), identityTotal=len(pids),
            runnable=dict(buckets=dict(counts) if sampled_threads else None, covered=covered, total=len(candidates),
                processLimit=process_limit,
                candidateCoverage=len(metrics), candidateTotal=len(current),
                runnable_low_cpu=low if sampled_threads else None, cpuUnknown=unknown,
                top=sorted(top, key=lambda r:(-r['runnable'], r['pid']))[:10]),
            offbox=classes, offboxWindowS=tick_window)


class Monitor:
    def __init__(self, sampler, clock=time.monotonic):
        self.sampler, self.clock = sampler, clock
        self.results = deque(maxlen=180)
        self.started = clock()
        self.previous_report = self.started
        self.active = None

    def loop(self, stop):
        while not stop.is_set():
            self.active = self.clock()
            result = self.sampler.tick()
            self.results.append(result)
            self.active = None
            stop.wait(max(0, self.sampler.interval-(self.clock()-result['at'])))

    def report(self):
        report_started, cpu_started = self.clock(), time.thread_time()
        now = self.clock()
        rows = []
        for _ in range(len(self.results)):
            rows.append(self.results.popleft())
        if any(r['at'] < self.previous_report for r in rows):
            for r in rows:
                r['partialReasons'] = sorted(set(r['partialReasons']) | {'late_tick'})
        span = now-self.previous_report
        self.previous_report = now
        good = [r for r in rows if 'births' in r]
        reasons = {s for r in rows for s in r['partialReasons']}
        age = now-good[-1]['at'] if good else None
        if not good or age > self.sampler.interval+2:
            reasons.add('stale')
        if self.active is not None and now-self.active >= self.sampler.budget:
            reasons.add('native_call_in_flight')
        wall, cpu = sum(r.get('wallMs', 0) for r in rows), sum(r.get('cpuMs', 0) for r in rows)
        actions = [a for r in rows for a in r.get('guardActions', [])]
        if wall > 1500 or cpu > span*20:
            actions.append(self.sampler.degrade('minute_wall' if wall > 1500 else 'minute_cpu',
                                               wall, cpu/(span*10) if span else 0))
        phases = {}
        for r in rows:
            for name, cost in r.get('phaseCosts', {}).items():
                total = phases.setdefault(name, dict(wallMs=0, cpuMs=0))
                for k in total:
                    total[k] += cost[k]
        parents = {}
        for r in good:
            for p in r['parents']:
                key = p['ppid'], p['parent_start']
                entry = parents.setdefault(key, dict(p, births=0, children=Counter()))
                entry['births'] += p['births']
                entry['children'].update(p['children'])
        top = sorted(parents.values(), key=lambda p:(-p['births'], p['ppid']))[:10]
        for p in top:
            p['child_comms_top3'] = [dict(comm=k, births=v) for k,v in p.pop('children').most_common(3)]
            if p['parent_start'] is not None:
                p['family'] = self.sampler.labels.get((p['ppid'], p['parent_start']), {}).get('family') or p['family']
        latest = good[-1] if good else {}
        births = sum(r['births'] for r in good)
        wall += (self.clock()-report_started)*1000
        cpu += (time.thread_time()-cpu_started)*1000
        return dict(method=METHOD, lower_bound=True, windowS=span, ticks=len(rows),
            births=births, exits=sum(r['exits'] for r in good), births_per_min=births*60/span if span else None,
            baseline=any(r['baseline'] for r in good), partial=bool(reasons), partialReasons=sorted(reasons),
            top_spawners=top, runnable=latest.get('runnable'), offbox=latest.get('offbox'),
            offboxWindowS=latest.get('offboxWindowS'),
            identityCovered=latest.get('identityCovered'), identityTotal=latest.get('identityTotal'),
            sampleAgeS=age, wallMs=wall, cpuMs=cpu, cpuPct=cpu/(span*10) if span else None,
            phaseCosts=phases, guardActions=actions, threadLimit=self.sampler.thread_limit,
            costIncomplete='native_call_in_flight' in reasons,
            inFlightWallMs=(now-self.active)*1000 if self.active is not None else None,
            intervalS=self.sampler.interval, threadsEnabled=self.sampler.threads_enabled,
            tickWallMaxMs=max((r.get('wallMs', 0) for r in rows), default=None))

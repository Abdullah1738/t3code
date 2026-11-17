import ctypes
import errno
import datetime as dt
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cpu
import toollog

START = 'Sat Nov 14 10:20:30 2026'


def proc(pid, ppid=0, own=0, children=0, family='zsh', start=START, uid=501):
    return dict(pid=pid, ppid=ppid, uid=uid, cpuS=own, rssMb=1, state='S', start=start,
                etime='10:00', family=family, children=children)


def snapshot(rows):
    return {str(p['pid']): dict(start=p['pid']+1000, psStart=p['start'], ownS=p['cpuS'],
            childS=p['children'], ppid=p['ppid'], uid=p['uid'], family=p['family']) for p in rows}


def measure(before, after):
    _, old = cpu.deltas(before, {}, 100)
    old['childReadings'] = snapshot(before)
    props, _ = cpu.deltas(after, old, 160)
    props['unattributedCpuPct'] = 500
    return cpu.child_cpu(after, snapshot(after), old, props)


class ChildCpuTests(unittest.TestCase):
    def test_mach_conversion_and_abi(self):
        def timebase(ptr):
            base = ctypes.cast(ptr, ctypes.POINTER(ctypes.c_uint32))
            base[0], base[1] = 125, 3
            return 0
        def rusage(pid, version, ptr):
            self.assertEqual((pid, version), (12, 1))
            usage = ctypes.cast(ptr, ctypes.POINTER(cpu.RusageInfoV1)).contents
            usage.child_user, usage.child_system = 4744253, 10208236
            usage.start = 123
            return 0
        lib = Mock(proc_pid_rusage=Mock(side_effect=rusage), mach_timebase_info=Mock(side_effect=timebase),
                   mach_absolute_time=Mock(return_value=1000))
        self.assertEqual(ctypes.sizeof(cpu.RusageInfoV1), 144)
        value = cpu.rusage_reader(lib)(12)
        self.assertAlmostEqual(value['childS'], .623020375)
        self.assertEqual(value['start'], 123)
        lib.mach_absolute_time.return_value = 122
        with self.assertRaises(OSError) as changed:
            cpu.rusage_reader(lib)(12)
        self.assertEqual(changed.exception.errno, errno.ESTALE)
        lib.proc_pid_rusage.side_effect = lambda *args: -1
        ctypes.set_errno(errno.EPERM)
        with self.assertRaises(OSError) as failure:
            cpu.rusage_reader(lib)(12)
        self.assertEqual(failure.exception.errno, errno.EPERM)

    def test_parent_grandparent_orphans_and_family_totals(self):
        before = [proc(1, family='launchd'), proc(10, 1, family='codex'), proc(20, 10), proc(21, 10)]
        after = [dict(p, children=60 if p['pid'] in (1, 20, 21) else 0) for p in before]
        result = measure(before, after)
        self.assertEqual(result['childCpuPct'], 300)
        self.assertEqual(result['unattributedAfterChildrenPct'], 200)
        self.assertIn(dict(family='zsh', parentFamily='codex', cpuPct=200), result['childCpuFamilies'])
        self.assertEqual(result['childCpu'][0]['family'], 'orphaned-exited')
        self.assertEqual(result['childCpu'][1]['pid'], 20)

    def test_reaped_lifetime_is_not_counted_twice(self):
        # Parent reaps a child with 120 s already seen (90 own + 30 reaped),
        # and 30 s of new work. Only the new work belongs to this minute.
        before = [proc(10), proc(20, 10, own=90, children=30)]
        result = measure(before, [proc(10, own=30, children=150)])
        self.assertEqual(result['childCpuPct'], 50)
        self.assertEqual(result['lostParents'], 1)
        result = measure(before, [proc(10, children=120)])
        self.assertEqual(result['childCpuPct'], 0)

    def test_child_before_parent_read_is_uncertain_and_inventory_is_reordered(self):
        before = [proc(10), proc(20, 10, own=90)]
        after = [proc(20, 10, own=90), proc(10, children=90)]
        result = measure(before, after)
        self.assertEqual(result['childCpuPct'], 0)
        self.assertEqual(result['childUncertainParents'], 1)
        calls = []
        def reader(pid):
            calls.append(pid)
            return dict(start=1, ownS=0, childS=0)
        cpu.child_snapshot(after, reader=reader)
        self.assertEqual(calls, [10, 20])

    def test_orphan_adoption_does_not_credit_old_grandchild_cpu_to_launchd(self):
        before = [proc(1, family='launchd'), proc(10, 1), proc(20, 10, own=10), proc(30, 20, own=90)]
        after = [proc(1, family='launchd', children=90), proc(10, 1, children=10)]
        result = measure(before, after)
        self.assertEqual(result['childCpuPct'], 0)
        self.assertEqual(result['childUncertainParents'], 1)

    def test_orphan_adoption_after_ps_missing_or_reused_rusage_is_uncertain(self):
        before = [proc(1, family='launchd'), proc(10, 1), proc(20, 10, own=10), proc(30, 20, own=90)]
        _, old = cpu.deltas(before, {}, 100)
        old['childReadings'] = snapshot(before)
        # Both descendants are still listed by ps, but exit during the rusage
        # pass. launchd's rollup must not make their old work look new.
        after = [dict(p, children=90 if p['pid'] == 1 else 10 if p['pid'] == 10 else 0) for p in before]
        props, _ = cpu.deltas(after, old, 160)
        for form in ('missing', 'reused'):
            with self.subTest(form=form):
                readings = snapshot(after)
                for pid in ('20', '30'):
                    if form == 'missing':
                        del readings[pid]
                    else:
                        readings[pid].update(start=9999, ownS=0, childS=0)
                result = cpu.child_cpu(after, readings, old, props)
                self.assertEqual(result['childCpuPct'], 0)
                self.assertGreaterEqual(result['childUncertainParents'], 1)

    def test_nested_reaping_subtracts_each_old_descendant_once(self):
        before = [proc(10), proc(20, 10, own=10, children=10), proc(30, 20, own=20)]
        result = measure(before, [proc(10, children=100)])
        self.assertAlmostEqual(result['childCpuPct'], 100*60/60, places=3)

    def test_negative_reset_reuse_baseline_and_missing_reads(self):
        before = [proc(10, children=100)]
        for after in ([proc(10, children=99)], [proc(10, children=200, start='Sun Nov 15 10:20:30 2026')]):
            self.assertEqual(measure(before, after)['childCpuPct'], 0)
        rows = [proc(10)]
        self.assertIsNone(cpu.child_cpu(rows, {}, {}, dict(baseline=True))['childCpuPct'])
        _, old = cpu.deltas(rows, {}, 100)
        old['childReadings'] = snapshot(rows)
        self.assertIsNone(cpu.child_cpu(rows, {}, old, dict(baseline=False))['childCpuPct'])

    def test_unreadable_old_child_suppresses_uncertain_lifetime(self):
        before = [proc(10), proc(20, 10, own=90)]
        _, old = cpu.deltas(before, {}, 100)
        old['childReadings'] = snapshot(before[:1])
        for after in ([proc(10, children=120)], [proc(10, children=120), before[1]]):
            props, _ = cpu.deltas(after, old, 160)
            value = cpu.child_cpu(after, snapshot(after[:1]), old, props)
            self.assertEqual(value['childCpuPct'], 0)
            self.assertEqual(value['childUncertainParents'], 1)

    def test_exiting_child_keeps_parent_metadata_without_zero_baseline(self):
        for state in ('?', '?E', '?s', '?N'):
            with self.subTest(state=state):
                before = [proc(10), proc(20, 10, own=90)]
                _, old = cpu.deltas(before, {}, 100)
                old['childReadings'] = snapshot(before)
                exiting = [proc(10), dict(proc(20, 10), state=state)]
                _, pending = cpu.deltas(exiting, old, 160)
                calls = []
                def reader(pid):
                    calls.append(pid)
                    return snapshot(exiting)[str(pid)]
                readings, coverage = cpu.child_snapshot(exiting, reader=reader)
                self.assertEqual(calls, [10])
                self.assertEqual(coverage['childUnreadable'], 1)
                pending['childReadings'] = readings
                self.assertNotIn('20', pending['processes'])
                self.assertIn('20', pending['exitingProcesses'])
                after = [proc(10, children=90)]
                props, _ = cpu.deltas(after, pending, 220)
                result = cpu.child_cpu(after, snapshot(after), pending, props)
                self.assertEqual(result['childCpuPct'], 0)
                self.assertEqual(result['childUncertainParents'], 1)

    def test_sub_millisecond_window_never_rounds_denominators_to_zero(self):
        before = [proc(10)]
        _, old = cpu.deltas(before, {}, 100)
        old['childReadings'] = snapshot(before)
        after = [proc(10, children=.0001), proc(20, 10)]
        for window in (.00001, .0001, .00049, .001, 60):
            with self.subTest(window=window):
                props, _ = cpu.deltas(after, old, 100+window)
                self.assertGreater(props['windowS'], 0)
                self.assertGreater(cpu.churn(after, old, props)['observedSpawnsPerMinuteLowerBound'], 0)
                self.assertGreaterEqual(cpu.child_cpu(after, snapshot(after), old, props)['childCpuPct'], 0)

    def test_coverage_by_uid_permission_exit_and_budget(self):
        rows = [proc(10, uid=0), proc(20), proc(30), proc(40)]
        def reader(pid):
            if pid in (10, 20):
                raise OSError(errno.EPERM if pid == 10 else errno.ESRCH, 'private')
            return dict(start=1, ownS=1, childS=2)
        values, coverage = cpu.child_snapshot(rows, reader, clock=iter([0, 1, 2, 3, 31]).__next__)
        self.assertEqual(list(values), ['30'])
        self.assertEqual((coverage['childReadable'], coverage['childUnreadable']), (1, 3))
        self.assertEqual(coverage['childCoverage'], [dict(uid=0, reason='permission', count=1),
            dict(uid=501, reason='exited', count=1), dict(uid=501, reason='timeout', count=1)])

    def test_normal_kernel_null_and_tick_sum(self):
        before = [proc(i) for i in range(30)]
        after = [dict(p, cpuS=p['pid']) for p in before]
        _, old = cpu.deltas(before, {}, 100)
        props, _ = cpu.deltas(after, old, 160)
        self.assertIsNone(props['kernelTaskPct'])
        self.assertNotIn(0, [p['pid'] for p in props['top']])
        value = cpu.system_cpu([50, 20, 100, 30], dict(ticks=[0]*4), props, 16)
        self.assertEqual(value['userPct']+value['sysPct']+value['nicePct'], value['systemCpuPct'])
        self.assertEqual(value['systemCpuPct']+value['idlePct'], 1600)

    def test_two_frame_kernel_task_and_bad_input_class(self):
        fixture = 'Processes: 1400\nPID %CPU TIME\n0 0.0 06:18:29\nProcesses: 1402\nPID %CPU TIME\n0 2.5 06:18:30\n'
        self.assertEqual(cpu.kernel_task(fixture), dict(kernelTaskPct=2.5, kernelTaskTime='06:18:30', kernelTaskWindowS=1))
        for bad in ('', fixture.split('Processes: 1402')[0], fixture.replace('2.5', 'NaN'),
                    fixture.replace('2.5', '-1'), fixture.replace('06:18:30', 'private'),
                    fixture.replace('0 2.5', '0 2.5 extra')):
            with self.subTest(bad=bad), self.assertRaises(cpu.ProbeError):
                cpu.kernel_task(bad)

    def test_observed_spawns_by_parent_is_a_window_normalized_lower_bound(self):
        before = [proc(10, family='codex')]
        after = before+[proc(20, 10), proc(21, 10)]
        _, old = cpu.deltas(before, {}, 100)
        props, _ = cpu.deltas(after, old, 130)
        result = cpu.churn(after, old, props)
        self.assertEqual(result['observedSpawnsLowerBound'], 2)
        self.assertEqual(result['observedSpawnsPerMinuteLowerBound'], 4)
        self.assertEqual(result['observedSpawnsByParent'], [dict(pid=10, family='codex', count=2, perMinute=4)])

    def test_new_fields_redaction_limits_and_spike_carry_through(self):
        rows = [proc(10)]
        props, _ = cpu.deltas(rows, {}, 100)
        props.update(childCpu=[dict(pid=10, ppid=1, family='/Users/private/node',
            parentFamily='--token=private', cpuPct=5, args='secret')]*15,
            childCpuPct=5, childCoverage=[dict(uid=0, reason='permission', count=10)],
            nicePct=10, idlePct=500, observedSpawnsLowerBound=10)
        spike = cpu.spike(props, [], lambda *a, **k: (_ for _ in ()).throw(OSError()))
        clean = toollog.cpu_fields(spike)
        self.assertEqual(len(clean['childCpu']), 10)
        self.assertEqual(clean['childCoverage'][0]['count'], 10)
        self.assertEqual(clean['childCpuPct'], 5)
        self.assertNotIn('private', str(clean))
        self.assertNotIn('args', str(clean))

    def test_maximum_new_payload_stays_bounded_and_keeps_child_top_ten(self):
        for label in ('a'*64, '界'*64, '😀'*64, '\\'*64, 'a界😀'*64):
            props = dict(childCpu=[dict(pid=i, ppid=1, family=label, parentFamily=label, cpuPct=100) for i in range(10)],
                childCpuFamilies=[dict(family=label, parentFamily=label, cpuPct=100)]*10,
                childCoverage=[dict(uid=i, reason='permission', count=1) for i in range(64)],
                observedSpawnsByParent=[dict(pid=i, family=label, count=1, perMinute=1) for i in range(10)])
            for name, limit in (('cpu.sample', 7000), ('cpu.spike', 8192)):
                with self.subTest(label=label[0], name=name):
                    row = toollog.record('cpu', 'event', name, dt.datetime.now(dt.timezone.utc), props=props)
                    self.assertLessEqual(len((json.dumps(row, separators=(',', ':'))+'\n').encode()), limit)
                    self.assertEqual(len(row['props']['childCpu']), 10)
                    self.assertEqual(len(row['props']['childCpuFamilies']), 10)

    def test_uid_input_class_and_corrupt_state(self):
        def line(uid):
            return f'10 1 0:01 1024 S {START} 10:00 {uid} (Python)\n'
        for uid in ('0', '501', '4294967294'):
            self.assertEqual(cpu.parse_ps(line(uid))[0]['uid'], int(uid))
        for uid in ('-1', 'bad', '1.5'):
            with self.subTest(uid=uid), self.assertRaises(cpu.ProbeError):
                cpu.parse_ps(line(uid))
        before = [proc(10)]
        _, old = cpu.deltas(before, {}, 100)
        for bad in (None, [], {'10': {}}, {'10': dict(start=1, psStart=START, ownS=float('nan'), childS=-1)}):
            props, _ = cpu.deltas(before, old, 160)
            cpu.child_cpu(before, snapshot(before), dict(old, childReadings=bad), props)


if __name__ == '__main__':
    unittest.main()

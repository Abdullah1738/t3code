import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import collector
import jobs
import toollog
from rollup import rollup


HEADER = '  PID  PPID     ELAPSED STAT COMM             ARGS'
START = 'Thu Nov 12 18:15:55 2026'


def ps_row(pid=99184, age='1-03:00:00', stat='U', comm='/sbin/umount',
           args='/sbin/umount -f /Users/ardud/checkouts', ppid=1):
    return '%5d %5d %11s %-4s %-16s %s' % (pid, ppid, age, stat, comm, args)


class DiskWaitTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.logs = self.root / 'logs'
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.logs), BUN_INSPECT='private')
        env.start()
        self.addCleanup(env.stop)
        sleeper = patch.object(collector.time, 'sleep')
        sleeper.start()
        self.addCleanup(sleeper.stop)
        self.notifications = []
        self.commands = []

    def rows(self, name=None):
        rows = [json.loads(line) for p in self.logs.glob('*.ndjson')
                for line in p.read_text().splitlines()]
        return [r for r in rows if name is None or r['name'] == name]

    def runner(self, rows=(), start=START, ps_failure=None, notify_failure=None,
               stats=None, cpus=None, sample_failure=None, vanish_at=None):
        sample_index = 0
        def run(cmd, **kwargs):
            nonlocal sample_index
            self.commands.append(cmd)
            self.assertLessEqual(kwargs['timeout'], 20)
            if cmd[:2] == ['/bin/ps', '-axo']:
                self.assertLessEqual(kwargs['timeout'], 10)
                self.assertEqual(cmd[2], 'pid,ppid,etime,stat,comm,args')
                if ps_failure == 'timeout':
                    raise subprocess.TimeoutExpired(cmd, 10)
                if ps_failure == 'exit':
                    return SimpleNamespace(returncode=1, stdout='', stderr='private')
                if ps_failure == 'parse':
                    return SimpleNamespace(returncode=0, stdout=HEADER+'\nmalformed')
                return SimpleNamespace(returncode=0, stdout=HEADER+'\n'+'\n'.join(rows))
            if cmd[:2] == ['/bin/ps', '-p']:
                self.assertLessEqual(kwargs['timeout'], 10)
                if cmd[-1] == 'pid=,stat=,time=':
                    i = sample_index
                    sample_index += 1
                    if sample_failure and i == 2:
                        if sample_failure == 'timeout':
                            raise subprocess.TimeoutExpired(cmd, kwargs['timeout'])
                        return SimpleNamespace(returncode=2, stdout='', stderr='private')
                    selected = [] if vanish_at is not None and i >= vanish_at else cmd[2].split(',')
                    stat = stats[i] if stats else 'U'
                    cpu = cpus[i] if cpus else '0:01.23'
                    return SimpleNamespace(returncode=0 if selected else 1, stdout='\n'.join(
                        pid+' '+stat+' '+cpu for pid in selected))
                self.assertEqual(cmd[-1], 'pid=,lstart=')
                self.assertEqual(kwargs['env']['TZ'], 'UTC')
                return SimpleNamespace(returncode=0, stdout='\n'.join(
                    pid+' '+start for pid in cmd[2].split(',')) if start else '')
            self.assertEqual(cmd[0], '/Users/ardud/.bun/bin/bun')
            self.assertNotIn('BUN_INSPECT', kwargs['env'])
            self.notifications.append((cmd[cmd.index('--text')+1], cmd[-1]))
            if notify_failure == 'raise':
                raise OSError('private notify failure')
            return SimpleNamespace(returncode=1 if notify_failure else 0)
        return run

    def test_empty_and_short_u_blip(self):
        for rows in ([], [ps_row(stat='S')], [ps_row(age='02:00', comm='git', args='git status')]):
            with self.subTest(rows=rows):
                collector.disk_wait(self.runner(rows))
                event = self.rows('proc.disk_wait')[-1]
                self.assertTrue(event['ok'])
                self.assertEqual(event['props'], dict(count=0, procs=[], stuckUnmount=False, busyCount=0, busy=[], sampleCount=0, sampling='full'))
        self.assertEqual(self.notifications, [])

    def test_umount_event_and_once_per_pid_and_start(self):
        for pid, start, expected in [(99184, START, 1), (99184, START, 1),
                                     (99185, START, 2), (99185, 'Fri Nov 13 18:15:55 2026', 3)]:
            collector.disk_wait(self.runner([ps_row(pid)], start=start))
            event = self.rows('proc.disk_wait')[-1]
            self.assertEqual(event['props'], dict(count=1, stuckUnmount=True,
                mountPoint='/Users/ardud/checkouts', busyCount=0, busy=[], sampleCount=6, sampling='full',
                procs=[dict(pid=pid, ppid=1, processAgeS=97200, stuckForS=97200, cpuTime='0:01.23', samples=['U']*6,
                stat='U', comm='/sbin/umount', args='/sbin/umount -f /Users/ardud/checkouts')]))
            self.assertEqual(len(self.notifications), expected)
        text, key = self.notifications[0]
        self.assertIn('stuck in disk wait for at least 27.0h, unmounting /Users/ardud/checkouts', text)
        self.assertEqual(key, 'mac-upkeep:disk-wait:99184:1794507355')

    def test_transient_recovery_does_not_alert_same_process_again(self):
        collector.disk_wait(self.runner([ps_row()]))
        collector.disk_wait(self.runner([ps_row(stat='S')]))
        collector.disk_wait(self.runner([ps_row()]))
        self.assertEqual(len(self.notifications), 1)

    def test_threshold_matrix(self):
        cases = [('09:59', 'umount', False, False), ('10:00', 'umount', True, False),
                 ('29:59', 'umount', True, False), ('30:00', 'umount', True, True),
                 ('05:59:59', 'git', True, False), ('06:00:00', 'git', True, False)]
        for i, (age, comm, reported, alerted) in enumerate(cases):
            with self.subTest(age=age, comm=comm):
                before = len(self.notifications)
                collector.disk_wait(self.runner([ps_row(pid=100+i, age=age, comm=comm,
                                                        args=comm+' /Volumes/Test')]))
                self.assertEqual(self.rows('proc.disk_wait')[-1]['props']['count'], int(reported))
                self.assertEqual(len(self.notifications)-before, int(alerted))

    def test_notify_failures_retry_frozen_text_without_failing_collection(self):
        for failure in ('raise', 'exit'):
            with self.subTest(failure=failure):
                jobs.save_state('disk-wait-alert', {})
                self.notifications = []
                collector.disk_wait(self.runner([ps_row()], notify_failure=failure))
                self.assertFalse(self.rows('proc.disk_wait_alert')[-1]['ok'])
                self.assertTrue(self.rows('proc.disk_wait')[-1]['ok'])
                collector.disk_wait(self.runner([ps_row(age='1-04:00:00')]))
                collector.disk_wait(self.runner([ps_row(age='1-05:00:00')]))
                self.assertEqual(len(self.notifications), 2)
                self.assertEqual(self.notifications[0], self.notifications[1])
                self.assertNotIn('private notify failure', str(self.rows()))

    def test_ps_errors_do_not_stop_other_collector_sources(self):
        for failure in ('timeout', 'exit', 'parse'):
            with self.subTest(failure=failure):
                run = self.runner(ps_failure=failure)
                real_wait = collector.disk_wait
                with patch.object(collector, 'collect') as crashes, \
                     patch.object(collector, 'disk_wait', side_effect=lambda **kw: real_wait(run, **kw)), \
                     patch.object(collector, 'disk_tooling_probe') as disk, \
                     patch.object(collector, 'directory_inventory') as inventory:
                    collector.main()
                crashes.assert_called_once()
                disk.assert_called_once()
                inventory.assert_called_once()
                row = self.rows('proc.disk_wait')[-1]
                self.assertFalse(row['ok'])
                self.assertEqual(row['props']['failure'], failure)
                self.assertEqual(row['error']['tag'], 'proc.ps_failed')

    def test_missing_start_does_not_invent_identity_or_fail_event(self):
        collector.disk_wait(self.runner([ps_row()], start=None))
        self.assertEqual(self.notifications, [])
        self.assertTrue(self.rows('proc.disk_wait')[-1]['ok'])
        collector.disk_wait(self.runner([ps_row()]))
        self.assertEqual(len(self.notifications), 1)

    def test_capped_oldest_rows_still_flag_unmount(self):
        rows = [ps_row(pid=i+100, age='2-00:00:00', comm='git', args='git '+('x'*400))
                for i in range(12)]
        rows.append(ps_row())
        collector.disk_wait(self.runner(rows))
        props = self.rows('proc.disk_wait')[-1]['props']
        self.assertEqual(props['count'], 13)
        self.assertEqual(len(props['procs']), 10)
        self.assertEqual(len(next(p for p in props['procs'] if p['comm'] == 'git')['args']), 300)
        self.assertEqual(props['procs'][0]['pid'], 99184)
        self.assertEqual(props['procs'][0]['stuckForS'], 97200)
        self.assertTrue(props['stuckUnmount'])
        self.assertEqual(props['mountPoint'], '/Users/ardud/checkouts')
        self.assertEqual(len(self.notifications), 1)

    def test_fixed_width_comm_with_spaces_and_mount_option_forms(self):
        proc = collector.process_snapshot(self.runner([
            ps_row(comm='Test App', args='/Applications/Test App --arg value')]))[0]
        self.assertEqual(proc['comm'], 'Test App')
        self.assertEqual(proc['args'], '/Applications/Test App --arg value')
        for args, mount in [
            ('umount /Volumes/Test', '/Volumes/Test'),
            ('/sbin/umount -f /Users/ardud/checkouts', '/Users/ardud/checkouts'),
            ('umount -fv /Volumes/My Disk', '/Volumes/My Disk'),
            ('umount -- /Volumes/My Disk', '/Volumes/My Disk'),
            ('umount -t nfs /Volumes/Test', '/Volumes/Test'),
            ('umount -tnfs /Volumes/Test', '/Volumes/Test'),
            ('umount -ft nfs /Volumes/Test', '/Volumes/Test'),
            ('umount -ftnfs /Volumes/Test', '/Volumes/Test'),
            ('umount -h host /Volumes/Test', '/Volumes/Test'),
            ('umount -hhost /Volumes/Test', '/Volumes/Test'),
            ('umount -fvh host /Volumes/My Disk', '/Volumes/My Disk'),
            ('umount -fvhhost /Volumes/My Disk', '/Volumes/My Disk'),
            ('umount -a', None), ('umount -A', None),
            ('umount -at nfs', None), ('umount -atnfs', None),
            ('umount -a -t nfs', None), ('umount -Atnfs', None),
            ('umount -ah host', None), ('umount -ahhost', None),
            ('umount -t', None), ('umount -htype', None),
            ('umount -- -volume', '-volume'), ('umount', None)]:
            with self.subTest(args=args):
                self.assertEqual(collector.unmount_point(dict(comm='umount', args=args)), mount)

    def test_all_mount_option_event_alert_and_rollup_have_no_invented_path(self):
        for args in ('umount -at nfs', 'umount -atnfs', 'umount -Ah host'):
            with self.subTest(args=args):
                collector.disk_wait(self.runner([ps_row(args=args)]))
                props = self.rows('proc.disk_wait')[-1]['props']
                self.assertTrue(props['stuckUnmount'])
                self.assertNotIn('mountPoint', props)
        self.assertEqual(len(self.notifications), 1)
        self.assertNotIn('unmounting', self.notifications[0][0])

    def test_etime_forms_and_invalid_input(self):
        for value, expected in [('00:01', 1), ('59:59', 3599), ('01:02:03', 3723),
                                ('1-03:00:00', 97200), ('12-00:00:00', 1036800)]:
            self.assertEqual(collector.elapsed_seconds(value), expected)
        for value in ('', 'invalid', '-1:00', '00:60', '1:2:3', '1-02:03'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                collector.elapsed_seconds(value)

    def test_schema_bounds_and_redaction_only_for_disk_wait(self):
        proc = dict(pid=1, ppid=0, processAgeS=1000, stuckForS=0, cpuTime='0:01.23', samples=['U']*6, stat='U', comm='git',
                    args='git --token=private', environment='private')
        now = dt.datetime.now(dt.timezone.utc)
        for name in ('proc.disk_wait', 'other.event'):
            toollog.emit('proc', 'event', name, now=now,
                         props=dict(procs=[proc], environment='private'))
        self.assertEqual(self.rows('proc.disk_wait')[-1]['props']['procs'][0]['args'], '[redacted]')
        self.assertNotIn('environment', str(self.rows()))
        self.assertNotIn('props', self.rows('other.event')[-1])

    def test_lock_and_exhausted_budget_skip_notify(self):
        import fcntl
        root = jobs.state_path('disk-wait-alert').parent
        with (root/'disk-wait-alert.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            collector.disk_wait(self.runner([ps_row()]))
        self.assertEqual(self.notifications, [])
        collector.disk_wait(self.runner([ps_row()]), deadline=0)
        self.assertEqual(self.rows('proc.disk_wait')[-1]['props']['failure'], 'timeout')
        self.assertEqual(len(self.commands), 8)

    def test_notification_budget_defers_remaining_processes(self):
        clock = [0]
        base = self.runner([ps_row(pid=i) for i in range(1, 5)])
        def run(cmd, **kwargs):
            result = base(cmd, **kwargs)
            if cmd[0] != '/bin/ps':
                clock[0] += 20
            return result
        with patch.object(collector.time, 'monotonic', side_effect=lambda: clock[0]):
            collector.disk_wait(run)
        self.assertEqual(len(self.notifications), 3)
        collector.disk_wait(base)
        self.assertEqual(len(self.notifications), 4)

    def test_busy_and_cpu_moving_never_alert_from_uptime(self):
        for stats in (['U', 'R', 'U', 'R', 'U', 'R'], ['U']*6, ['R']*6, ['S']*6):
            with self.subTest(stats=stats):
                props = collector.disk_wait(self.runner([ps_row(pid=5717, age='4-00:00:00', comm='msgs')],
                    stats=stats, cpus=['0:01.00', '0:01.10', '0:01.20', '0:01.30', '0:01.40', '0:01.50']))
                self.assertEqual(props['count'], 0)
                self.assertEqual(props['busy'], [dict(pid=5717, comm='msgs', processAgeS=345600,
                                                     statSamples=stats, cpuDeltaS=.5)])
                self.assertEqual(props['sampleCount'], 6)
                self.assertEqual(props['sampling'], 'full')
        self.assertEqual(self.notifications, [])

    def test_frozen_duration_second_run_alerts_third_does_not(self):
        now = 1800000000
        for offset, alerts in [(0, 0), (7*3600, 1), (8*3600, 1)]:
            with patch.object(collector.time, 'time', return_value=now+offset):
                props = collector.disk_wait(self.runner([ps_row(pid=5717, age='4-00:00:00', comm='msgs')]))
            self.assertEqual(props['procs'][0]['stuckForS'], offset)
            self.assertEqual(len(self.notifications), alerts)
        self.assertIn('at least 7.0h', self.notifications[0][0])

    def test_continuity_resets_on_recovery_reuse_and_cpu_progress_between_runs(self):
        for reset in ('non-U', 'busy', 'reuse', 'cpu', 'missing-start', 'missing-pid', 'failure'):
            with self.subTest(reset=reset):
                jobs.save_state('disk-wait-stuck', {})
                rows = [ps_row(pid=5717, age='4-00:00:00', comm='msgs')]
                with patch.object(collector.time, 'time', return_value=1800000000):
                    collector.disk_wait(self.runner(rows))
                start, cpus = START, None
                with patch.object(collector.time, 'time', return_value=1800003600):
                    if reset == 'non-U':
                        collector.disk_wait(self.runner([ps_row(pid=5717, stat='S')]))
                    elif reset == 'busy':
                        collector.disk_wait(self.runner(rows, stats=['U', 'R']*3))
                    elif reset == 'reuse':
                        start = 'Fri Nov 13 18:15:55 2026'
                    elif reset == 'cpu':
                        cpus = ['0:02.00']*6
                    elif reset == 'missing-start':
                        collector.disk_wait(self.runner(rows, start=None))
                    elif reset == 'missing-pid':
                        collector.disk_wait(self.runner([]))
                    else:
                        collector.disk_wait(self.runner(rows, sample_failure='timeout'))
                with patch.object(collector.time, 'time', return_value=1800025200):
                    props = collector.disk_wait(self.runner(rows, start=start, cpus=cpus))
                self.assertEqual(props['procs'][0]['stuckForS'], 0)
                self.assertEqual(self.notifications, [])

    def test_vanished_pid_dropped(self):
        for vanish_at in (0, 1, 3, 5):
            with self.subTest(vanish_at=vanish_at):
                props = collector.disk_wait(self.runner([ps_row()], vanish_at=vanish_at))
                self.assertEqual(props['count'], 0)
                self.assertEqual(props['busyCount'], 0)
                self.assertEqual(jobs.read_state('disk-wait-stuck'), {})
        self.assertEqual(self.notifications, [])

    def test_sample_failure_does_not_alert_and_clears_continuity(self):
        for failure in ('timeout', 'exit'):
            props = collector.disk_wait(self.runner([ps_row()], sample_failure=failure))
            self.assertEqual(props['count'], 0)
            self.assertEqual(props['sampling'], 'partial')
            self.assertEqual(props['failure'], failure)
            self.assertFalse(self.rows('proc.disk_wait')[-1]['ok'])
        props = collector.disk_wait(self.runner([ps_row()], cpus=['garbage']*6))
        self.assertEqual(props['failure'], 'parse')
        self.assertEqual(self.notifications, [])

    def test_partial_budget_needs_at_least_three_samples(self):
        for limit, expected_count in ((2, 0), (3, 1), (4, 1)):
            clock = [0.0]
            base = self.runner([ps_row(comm='msgs')])
            def run(cmd, **kw):
                result = base(cmd, **kw)
                if cmd[-1] == 'pid=,stat=,time=':
                    clock[0] += 1
                return result
            with patch.object(collector.time, 'monotonic', side_effect=lambda: clock[0]):
                props = collector.disk_wait(run, deadline=limit+.5)
            self.assertEqual(props['sampleCount'], limit)
            self.assertEqual(props['sampling'], 'partial')
            self.assertEqual(props['count'], expected_count)
        self.assertEqual(self.notifications, [])

    def test_deadline_partial_preserves_existing_non_umount_duration(self):
        rows = [ps_row(pid=5717, age='4-00:00:00', comm='msgs')]
        now = 1800000000
        with patch.object(collector.time, 'time', return_value=now):
            collector.disk_wait(self.runner(rows))
        clock, calls = [0.0], [0]
        base = self.runner(rows)
        def run(cmd, **kw):
            if cmd[-1] == 'pid=,stat=,time=':
                calls[0] += 1
                if calls[0] == 4:
                    clock[0] = 10
                    raise subprocess.TimeoutExpired(cmd, kw['timeout'])
            return base(cmd, **kw)
        with patch.object(collector.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(collector.time, 'time', return_value=now+7*3600):
            props = collector.disk_wait(run, deadline=10)
        self.assertEqual(props['sampling'], 'partial')
        self.assertEqual(props['sampleCount'], 3)
        self.assertEqual(props['procs'][0]['stuckForS'], 7*3600)
        self.assertEqual(jobs.read_state('disk-wait-stuck')['5717']['firstStuckAt'], now)
        self.assertEqual(self.notifications, [])
        with patch.object(collector.time, 'time', return_value=now+8*3600):
            props = collector.disk_wait(self.runner(rows))
        self.assertEqual(props['procs'][0]['stuckForS'], 8*3600)
        self.assertEqual(len(self.notifications), 1)

    def test_invalid_cached_stuck_timestamp_preserves_observation_and_recovers(self):
        now = 1800000000
        for value in (10**309, -10**309, 10**400, -10**400, float('nan'),
                      float('inf'), float('-inf'), True, False, None, '123', {}, [], -1, now+1):
            with self.subTest(value=value):
                jobs.save_state('disk-wait-stuck', {})
                jobs.save_state('disk-wait-alert', {})
                self.notifications = []
                with patch.object(collector.time, 'time', return_value=now):
                    collector.disk_wait(self.runner([ps_row()]))
                state = jobs.read_state('disk-wait-stuck')
                state['99184']['firstStuckAt'] = value
                jobs.save_state('disk-wait-stuck', state)
                with patch.object(collector.time, 'time', return_value=now):
                    props = collector.disk_wait(self.runner([ps_row()]))
                self.assertTrue(self.rows('proc.disk_wait')[-1]['ok'])
                self.assertEqual(props['count'], 1)
                self.assertEqual(props['procs'][0]['stuckForS'], 97200)
                self.assertEqual(jobs.read_state('disk-wait-stuck')['99184']['firstStuckAt'], now)
                with patch.object(collector.time, 'time', return_value=now+7*3600):
                    collector.disk_wait(self.runner([ps_row()]))
                self.assertEqual(jobs.read_state('disk-wait-stuck')['99184']['firstStuckAt'], now)
                self.assertEqual(len(self.notifications), 1)

    def test_existing_sent_incident_is_not_sent_again(self):
        entry = dict(key='mac-upkeep:disk-wait:99184:1794507355',
                     text='old process-age alert', sent=True)
        jobs.save_state('disk-wait-alert', {'99184': entry})
        props = collector.disk_wait(self.runner([ps_row()]))
        self.assertTrue(props['stuckUnmount'])
        self.assertEqual(self.notifications, [])
        self.assertEqual(jobs.read_state('disk-wait-alert')['99184'], entry)

    def test_deadline_timeout_retains_valid_partial_and_rollup_max(self):
        clock = [0.0]
        calls = [0]
        base = self.runner([ps_row()])
        def run(cmd, **kw):
            if cmd[-1] == 'pid=,stat=,time=':
                calls[0] += 1
                if calls[0] == 4:
                    clock[0] = 10
                    raise subprocess.TimeoutExpired(cmd, kw['timeout'])
            return base(cmd, **kw)
        with patch.object(collector.time, 'monotonic', side_effect=lambda: clock[0]):
            props = collector.disk_wait(run, deadline=10)
        self.assertEqual(props['sampleCount'], 3)
        self.assertEqual(props['sampling'], 'partial')
        self.assertEqual(props['count'], 1)
        self.assertEqual(props['procs'][0]['stuckForS'], 97200)
        self.assertEqual(self.notifications, [])
        day = self.rows('proc.disk_wait')[-1]['ts'][:10]
        self.assertEqual(rollup(day)['diskWait']['maxStuckForS'], 97200)

    def test_parsed_equal_cpu_times_and_missing_pid_among_survivors(self):
        rows = [ps_row(pid=1), ps_row(pid=2)]
        base = self.runner(rows, cpus=['0:01.23', '00:01.23']*3)
        sample = [0]
        def run(cmd, **kw):
            result = base(cmd, **kw)
            if cmd[-1] == 'pid=,stat=,time=':
                sample[0] += 1
                if sample[0] == 3:
                    result.stdout = '1 U 0:01.23'
            return result
        props = collector.disk_wait(run)
        self.assertEqual([p['pid'] for p in props['procs']], [1])
        self.assertEqual(props['sampleCount'], 6)
        self.assertEqual(props['sampling'], 'full')
        self.assertEqual(len(self.notifications), 1)

    def test_cpu_time_parser_forms(self):
        for value, seconds in [('0:01.23', 1.23), ('12:34.56', 754.56),
                               ('1:02:03.04', 3723.04), ('2-01:02:03.04', 176523.04),
                               ('00:00', 0), ('123:45.00', 7425), ('1:02:03', 3723)]:
            with self.subTest(value=value):
                self.assertAlmostEqual(collector.cpu_seconds(value), seconds)
        for value in ('', 'garbage', '-1:00', '0:60', '1:2:03', '2-02:03', 'nan', '1:00:00:00'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                collector.cpu_seconds(value)

    def test_schema_constrained_to_new_fields(self):
        proc = dict(pid=1, ppid=0, processAgeS=1000, stuckForS=0, cpuTime='0:01.23',
                    samples=['U']*20, stat='U', comm='git', args='x'*400, ageS=999, extra='private')
        busy = dict(pid=2, comm='msgs', processAgeS=2000, statSamples=['U', 'R']*10, cpuDeltaS=.2, extra='private')
        props = toollog.safe_fields(dict(count=1, procs=[proc]*12, busyCount=1, busy=[busy]*12,
            sampleCount=6, sampling='full', ageS=999, extra='private'), 'proc.disk_wait')
        self.assertEqual(set(props), {'count', 'procs', 'busyCount', 'busy', 'sampleCount', 'sampling'})
        self.assertEqual(len(props['procs']), 10)
        self.assertEqual(len(props['busy']), 10)
        self.assertEqual(len(props['procs'][0]['args']), 300)
        self.assertEqual(props['procs'][0]['samples'], ['U']*6)
        self.assertEqual(props['busy'][0]['statSamples'], ['U', 'R']*3)
        self.assertNotIn('ageS', str(props))
        self.assertNotIn('extra', str(props))
        for key, value in [('stuckForS', -1), ('processAgeS', True), ('cpuTime', 'private'), ('samples', ['bad value'])]:
            bad = dict(proc, **{key: value})
            self.assertEqual(toollog.safe_fields({'procs': [bad]}, 'proc.disk_wait'), {'procs': []})

    def test_rollup_old_and_new_lines(self):
        now = dt.datetime(2026, 11, 14, tzinfo=dt.timezone.utc)
        for minute, count, duration, mount in [(1, 0, 0, None), (3, 1, 97200, '/new'),
                                              (2, 2, 98000, '/old')]:
            procs = [dict(pid=1, ppid=0, processAgeS=99000, stuckForS=duration,
                          cpuTime='0:01.23', samples=['U']*6, stat='U', comm='umount', args='umount '+mount)] if count else []
            busy = [dict(pid=2, comm='msgs', processAgeS=345600, statSamples=['U', 'R'], cpuDeltaS=1)]
            toollog.emit('proc', 'event', 'proc.disk_wait', now=now.replace(minute=minute),
                         props=dict(count=count, procs=procs, stuckUnmount=bool(mount), mountPoint=mount,
                                    busyCount=1, busy=busy))
        legacy = dict(tool='mac', kind='event', name='proc.disk_wait', ts='2026-11-14T00:00:00Z',
                      props=dict(count=1, procs=[dict(pid=1, ppid=0, ageS=345600, stat='U', comm='msgs', args='msgs')]))
        with (self.logs/'2026-11-14.ndjson').open('a') as stream:
            stream.write(json.dumps(legacy)+'\n')
        result = rollup('2026-11-14')
        self.assertEqual(result['malformed'], 0)
        self.assertEqual(result['diskWait'], dict(runs=3, maxStuckForS=98000, legacyMaxProcessAgeS=345600,
            latestStuckUnmountMountPoint='/new', busyRuns=3, topBusyComms=[dict(comm='msgs', count=3)]))



if __name__ == '__main__':
    unittest.main()

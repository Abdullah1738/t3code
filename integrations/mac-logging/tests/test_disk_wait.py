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
        self.notifications = []
        self.commands = []

    def rows(self, name=None):
        rows = [json.loads(line) for p in self.logs.glob('*.ndjson')
                for line in p.read_text().splitlines()]
        return [r for r in rows if name is None or r['name'] == name]

    def runner(self, rows=(), start=START, ps_failure=None, notify_failure=None):
        def run(cmd, **kwargs):
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
                self.assertEqual(event['props'], dict(count=0, procs=[], stuckUnmount=False))
        self.assertEqual(self.notifications, [])

    def test_umount_event_and_once_per_pid_and_start(self):
        for pid, start, expected in [(99184, START, 1), (99184, START, 1),
                                     (99185, START, 2), (99185, 'Fri Nov 13 18:15:55 2026', 3)]:
            collector.disk_wait(self.runner([ps_row(pid)], start=start))
            event = self.rows('proc.disk_wait')[-1]
            self.assertEqual(event['props'], dict(count=1, stuckUnmount=True,
                mountPoint='/Users/ardud/checkouts', procs=[dict(pid=pid, ppid=1, ageS=97200,
                stat='U', comm='/sbin/umount', args='/sbin/umount -f /Users/ardud/checkouts')]))
            self.assertEqual(len(self.notifications), expected)
        text, key = self.notifications[0]
        self.assertIn('process age 27.0h, unmounting /Users/ardud/checkouts', text)
        self.assertEqual(key, 'mac-upkeep:disk-wait:99184:1794507355')

    def test_transient_recovery_does_not_alert_same_process_again(self):
        collector.disk_wait(self.runner([ps_row()]))
        collector.disk_wait(self.runner([ps_row(stat='S')]))
        collector.disk_wait(self.runner([ps_row()]))
        self.assertEqual(len(self.notifications), 1)

    def test_threshold_matrix(self):
        cases = [('09:59', 'umount', False, False), ('10:00', 'umount', True, False),
                 ('29:59', 'umount', True, False), ('30:00', 'umount', True, True),
                 ('05:59:59', 'git', True, False), ('06:00:00', 'git', True, True)]
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
        self.assertEqual(len(props['procs'][0]['args']), 300)
        self.assertTrue(props['stuckUnmount'])
        self.assertEqual(props['mountPoint'], '/Users/ardud/checkouts')
        self.assertEqual(len(self.notifications), 13)

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
        proc = dict(pid=1, ppid=0, ageS=1000, stat='U', comm='git',
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
        self.assertEqual(len(self.commands), 1)

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

    def test_rollup_counts_max_age_and_latest_mount_by_timestamp(self):
        now = dt.datetime(2026, 11, 14, tzinfo=dt.timezone.utc)
        for minute, count, age, mount in [(1, 0, 0, None), (3, 1, 97200, '/new'),
                                          (2, 2, 98000, '/old')]:
            procs = [dict(pid=1, ppid=0, ageS=age, stat='U', comm='umount', args='umount '+mount)] if count else []
            toollog.emit('proc', 'event', 'proc.disk_wait', now=now.replace(minute=minute),
                         props=dict(count=count, procs=procs, stuckUnmount=bool(mount), mountPoint=mount))
        result = rollup('2026-11-14')
        self.assertEqual(result['diskWait'], dict(runs=2, maxAgeS=98000,
                                                  latestStuckUnmountMountPoint='/new'))


if __name__ == '__main__':
    unittest.main()

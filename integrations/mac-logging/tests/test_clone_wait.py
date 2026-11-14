import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import collector
import toollog
from rollup import rollup


def proc(pid=10, comm='/bin/cp', args='cp -c /src /dst', stat='U'):
    return dict(pid=pid, ppid=1, comm=comm, args=args, stat=stat, processAgeS=2)


class CloneWaitTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.root), BUN_INSPECT='private')
        env.start()
        self.addCleanup(env.stop)
        sleeper = patch.object(collector.time, 'sleep')
        sleeper.start()
        self.addCleanup(sleeper.stop)
        self.notifications = []

    def runner(self, stats=None, cpus=None, vanish=None, reused=None, failure=None,
               notify_failure=False, notify_interrupted=False):
        samples, starts = [0], [0]
        def run(cmd, **kw):
            self.assertGreater(kw['timeout'], 0)
            self.assertLessEqual(kw['timeout'], 20)
            if cmd[0] == '/bin/ps':
                self.assertEqual(cmd[1], '-p')
                pids = cmd[2].split(',')
                output = []
                if cmd[-1] == 'pid=,stat=,time=':
                    index = samples[0]
                    samples[0] += 1
                    if failure and index == 1:
                        if failure == 'timeout':
                            raise subprocess.TimeoutExpired(cmd, kw['timeout'])
                        return SimpleNamespace(returncode=2, stdout='')
                    for pid in pids:
                        if vanish == int(pid) and index > 0:
                            continue
                        states = (stats or {}).get(int(pid), ['U']*3)
                        cpu = (cpus or {}).get(int(pid), ['0:00.00']*3)
                        output.append('%s %s %s' % (pid, states[index], cpu[index]))
                elif cmd[-1] == 'pid=,lstart=':
                    starts[0] += 1
                    for pid in pids:
                        day = '13' if reused == int(pid) and starts[0] > 1 else '12'
                        output.append('%s Thu Nov %s 18:15:55 2026' % (pid, day))
                else:
                    self.assertEqual(cmd[-1], 'pid=,wchan=')
                    output = [pid+' vnode' for pid in pids]
                return SimpleNamespace(returncode=0, stdout='\n'.join(output))
            self.assertEqual(cmd[0], '/Users/ardud/.bun/bin/bun')
            self.assertNotIn('BUN_INSPECT', kw['env'])
            self.notifications.append((cmd[cmd.index('--text')+1], cmd[-1]))
            if notify_interrupted:
                raise KeyboardInterrupt()
            return SimpleNamespace(returncode=int(notify_failure))
        return run

    def rows(self, name='disk.clone_wedge'):
        return [r for p in self.root.glob('*.ndjson') for line in p.read_text().splitlines()
                if (r := json.loads(line))['name'] == name]

    def probe(self, rows, **kw):
        collector.clone_wait(rows, self.runner(**kw), time.monotonic()+30)
        return self.rows()[-1]

    def test_clone_flag_forms_and_operand_boundaries(self):
        cases = [('/bin/cp', 'cp -c /src /dst', True),
                 ('cp', 'cp -ac /src /dst', True),
                 ('cp', 'cp -v -c -- /src /dst', True),
                 ('clonefile', 'clonefile /src /dst', True),
                 ('cp', 'cp /src /dst', False),
                 ('cp', 'cp /src -c', False),
                 ('cp', 'cp -- -c /dst', False),
                 ('node', 'node -c /script', False),
                 ('sh', 'sh -c "cp -c /src /dst"', False),
                 ('cp', 'cp -c "unclosed', True)]
        for comm, args, expected in cases:
            with self.subTest(args=args):
                clone, _ = collector.clone_wait_paths(proc(comm=comm, args=args))
                self.assertEqual(clone, expected)

    def test_young_clone_with_cpu_progress_logs_and_alerts_once(self):
        for _ in range(2):
            event = self.probe([proc()], cpus={10: ['0:00.00', '0:00.10', '0:00.20']})
        self.assertTrue(event['ok'])
        self.assertEqual(event['props']['sampleCount'], 3)
        self.assertEqual(event['props']['procs'], [dict(pid=10, path='/dst', reason='clone',
            processAgeS=2, wchan='vnode', cpuDeltaS=.2)])
        self.assertEqual(len(self.notifications), 1)
        self.assertIn('may be progressing', self.notifications[0][0])
        self.assertEqual(self.notifications[0][1], 'mac-upkeep:clone-wait:10:1794507355')

    def test_relative_clone_destination_is_logged_without_resolving_cwd(self):
        event = self.probe([proc(args='cp -c /src relative.sqlite')])
        self.assertEqual(event['props']['procs'][0]['path'], 'relative.sqlite')

    def test_shared_path_requires_three_u_samples_and_deduplicates_group(self):
        rows = [proc(11, 'stat', 'stat /dst'), proc(12, 'sqlite3', 'sqlite3 /dst')]
        event = self.probe(rows, stats={12: ['U', 'R', 'U']})
        self.assertEqual(event['props']['count'], 0)
        event = self.probe(rows)
        self.assertEqual(event['props']['count'], 2)
        self.assertTrue(all(p['reason'] == 'shared_path' for p in event['props']['procs']))
        self.assertEqual(len(self.notifications), 1)

    def test_recovered_clone_and_recovered_member_are_not_reported(self):
        self.assertEqual(self.probe([proc()], stats={10: ['R', 'S', 'R']})['props']['count'], 0)
        rows = [proc(pid, 'stat', 'stat /dst') for pid in (11, 12, 13)]
        event = self.probe(rows, stats={11: ['R', 'R', 'R']})
        self.assertEqual([p['pid'] for p in event['props']['procs']], [12, 13])
        self.probe(rows)
        self.assertEqual(len(self.notifications), 1)

    def test_clone_and_waiter_on_its_source_are_one_incident(self):
        rows = [proc(), proc(11, 'stat', 'stat /src')]
        self.probe(rows)
        self.assertEqual(len(self.notifications), 1)

    def test_group_identity_survives_rotating_waiters(self):
        for a, b in ((11, 12), (12, 13), (13, 14)):
            self.probe([proc(a, 'stat', 'stat /dst'), proc(b, 'stat', 'stat /dst')])
        self.assertEqual(len(self.notifications), 1)

    def test_collector_calls_clone_probe_for_a_young_process(self):
        header = '  PID  PPID     ELAPSED STAT COMM             ARGS'
        row = '%5d %5d %11s %-4s %-16s %s' % (10, 1, '00:02', 'U', '/bin/cp', 'cp -c /src /dst')
        base = self.runner()
        def run(cmd, **kw):
            if cmd[:2] == ['/bin/ps', '-axo']:
                return SimpleNamespace(returncode=0, stdout=header+'\n'+row)
            return base(cmd, **kw)
        collector.disk_wait(run)
        self.assertEqual(self.rows()[-1]['props']['count'], 1)
        self.assertEqual(len(self.notifications), 1)

    def test_disjoint_paths_sleeping_rows_and_old_umount_do_not_match(self):
        event = self.probe([proc(11, 'stat', 'stat /a'), proc(12, 'stat', 'stat /ab'),
                            proc(stat='S'), proc(13, '/sbin/umount', 'umount /a')])
        self.assertEqual(event['props']['count'], 0)
        self.assertEqual(self.notifications, [])

    def test_path_identity_matrix(self):
        cases = [
            ('stat /Volumes/My Disk/a', 'stat /Volumes/My Disk/b', 0),
            ('stat /Volumes/My Disk/a --flag', 'stat /Volumes/My Disk/b --flag', 0),
            ('stat /Volumes/My', 'stat /Volumes/My Disk/b', 0),
            ('stat /a', 'stat /ab', 0),
            ('stat /db query', 'stat /db different-query', 0),
            ('stat "/My Disk/db"', 'stat "/My Disk/db"', 0),
            ("stat /tmp/a'b'", 'stat /tmp/ab', 0),
            ('stat /tmp/a"b"', 'stat /tmp/ab', 0),
            ('stat /tmp/a\\b', 'stat /tmp/ab', 0),
            ('stat -- /db', 'stat -f %z /db', 2),
        ]
        for index, (a, b, count) in enumerate(cases):
            with self.subTest(a=a, b=b):
                rows = [proc(100+index*2, 'stat', a), proc(101+index*2, 'stat', b)]
                self.assertEqual(self.probe(rows)['props']['count'], count)

    def test_relative_redacted_and_truncated_paths_do_not_merge_incidents(self):
        for index, (a, b) in enumerate([
            ('backup.sqlite', 'backup.sqlite'),
            ('/password=one', '/password=two'),
            ('/'+('a'*310)+'/one', '/'+('a'*310)+'/two'),
        ]):
            with self.subTest(a=a):
                before = len(self.notifications)
                rows = [proc(200+index*2, args='cp -c /source '+a),
                        proc(201+index*2, args='cp -c /other-source '+b)]
                self.probe(rows)
                self.assertEqual(len(self.notifications)-before, 2)

    def test_log_cap_does_not_cap_notifications(self):
        rows = [proc(300+i, args='cp -c /source%d /dest%d' % (i, i)) for i in range(11)]
        event = self.probe(rows)
        self.assertEqual(event['props']['count'], 11)
        self.assertEqual(len(event['props']['procs']), 10)
        self.assertEqual(len(self.notifications), 11)
        self.probe(rows)
        self.assertEqual(len(self.notifications), 11)

    def test_quotes_and_spaces_do_not_establish_path_identity(self):
        rows = [proc(11, 'stat', 'stat "/My Disk/db" "/My Disk/db"'),
                proc(12, 'sqlite3', 'sqlite3 "/My Disk/db"')]
        self.assertEqual(self.probe(rows)['props']['count'], 0)
        self.assertEqual(self.notifications, [])

    def test_clone_detection_survives_literal_quote_and_escape_forms(self):
        destinations = ["/tmp/owner's-copy", '/tmp/owner"s-copy',
                        "/tmp/a'b'", '/tmp/a"b"', '/tmp/a\\b',
                        '"/My Disk/db"', '"unclosed']
        for command in ('cp -c', 'clonefile'):
            for index, destination in enumerate(destinations):
                with self.subTest(command=command, destination=destination):
                    pid = 500+index+(100 if command == 'clonefile' else 0)
                    before = len(self.notifications)
                    event = self.probe([proc(pid, command.split()[0], command+' /src '+destination)])
                    self.assertEqual(event['props']['count'], 1)
                    self.assertEqual(len(self.notifications), before+1)

    def test_vanished_and_recycled_pids_do_not_alert(self):
        for option in ('vanish', 'reused'):
            with self.subTest(option=option):
                event = self.probe([proc()], **{option: 10})
                self.assertEqual(event['props']['count'], 0)
        self.assertEqual(self.notifications, [])

    def test_partial_samples_fail_open_and_next_pass_works(self):
        for failure in ('timeout', 'exit'):
            event = self.probe([proc()], failure=failure)
            self.assertFalse(event['ok'])
            self.assertEqual(event['props']['sampling'], 'partial')
        self.assertEqual(self.notifications, [])
        self.assertTrue(self.probe([proc()])['ok'])

    def test_notification_retry_preserves_text_and_key_across_representative_exit(self):
        rows = [proc(11, 'stat', 'stat /dst'), proc(12, 'stat', 'stat /dst')]
        self.probe(rows, notify_failure=True)
        # A remaining member and a newcomer still represent the pending incident.
        self.probe([rows[1], proc(13, args='cp -c /src /dst')])
        self.assertEqual(len(self.notifications), 2)
        self.assertEqual(self.notifications[0], self.notifications[1])
        self.probe([rows[1], proc(13, args='cp -c /src /dst')])
        self.assertEqual(len(self.notifications), 2)

    def test_interrupted_notify_preserves_identity_for_surviving_members(self):
        rows = [proc(11, 'stat', 'stat /dst'), proc(12, 'stat', 'stat /dst')]
        with self.assertRaises(KeyboardInterrupt):
            self.probe(rows, notify_interrupted=True)
        self.probe([rows[1], proc(13, args='cp -c /src /dst')])
        self.assertEqual(len(self.notifications), 2)
        self.assertEqual(self.notifications[0], self.notifications[1])
        self.probe([rows[1], proc(13, args='cp -c /src /dst')])
        self.assertEqual(len(self.notifications), 2)

    def test_expired_budget_and_missing_identity_never_alert(self):
        collector.clone_wait([proc()], self.runner(), time.monotonic()-1)
        self.assertFalse(self.rows()[-1]['ok'])
        self.assertEqual(self.notifications, [])

    def test_schema_bounds_and_redacts_path(self):
        row = dict(pid=10, processAgeS=1, cpuDeltaS=0, path='/password=private',
                   wchan='vnode', reason='clone', extra='private')
        clean = toollog.safe_fields(dict(count=12, procs=[row]*12, extra='private'), 'disk.clone_wedge')
        self.assertEqual(len(clean['procs']), 10)
        self.assertEqual(clean['procs'][0]['path'], '[redacted]')
        self.assertNotIn('extra', str(clean))
        event = self.probe([proc(args='cp -c /src /password=private')])
        self.assertEqual(event['props']['procs'][0]['path'], '[redacted]')
        self.assertNotIn('password=', self.notifications[0][0])
        day = event['ts'][:10]
        self.assertEqual(rollup(day)['countsByName']['disk.clone_wedge'], 1)


if __name__ == '__main__':
    unittest.main()

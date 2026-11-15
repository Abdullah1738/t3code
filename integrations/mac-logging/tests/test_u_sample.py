import datetime as dt
import fcntl
import importlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import cpu
import jobs
import toollog
import u_sample
from rollup import rollup

NOW = dt.datetime(2026, 11, 15, 10, tzinfo=dt.timezone.utc)
START = 'Sun Nov 15 09:00:00 2026'
HEADER = f'{"PID":>5} {"PPID":>5} {"STARTED":>28} {"ELAPSED":>11} {"TIME":>14} {"STAT":4} {"COMM":60}ARGS'
COMM_AT, ARGS_AT = HEADER.index('COMM'), HEADER.index('ARGS')


def row(pid=10, ppid=1, age='10:00', stat='U', comm='/usr/bin/lsof', args='lsof -nP', start=START, cpu_time='0:01.23'):
    prefix = f'{pid:5} {ppid:5} {start:>28} {age:>11} {cpu_time:>14} {stat:4} '
    assert len(prefix) == COMM_AT
    return prefix+comm.ljust(ARGS_AT-COMM_AT)+args


def snapshot(*rows):
    return HEADER+'\n'+'\n'.join(rows or [row(stat='S')])+'\n'


class USampleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.root), BUN_INSPECT='private')
        env.start()
        self.addCleanup(env.stop)
        self.calls = []

    def runner(self, text, failure=None):
        def run(argv, **kw):
            self.calls.append(argv)
            self.assertEqual(argv, u_sample.PS)
            self.assertEqual(kw['timeout'], 5)
            self.assertEqual(kw['env']['LC_ALL'], 'C')
            self.assertNotIn('BUN_INSPECT', kw['env'])
            if failure == 'timeout':
                raise subprocess.TimeoutExpired(argv, 5, output='private output')
            if failure == 'unavailable':
                raise OSError('private path')
            return SimpleNamespace(returncode=1 if failure == 'exit' else 0, stdout=text)
        return run

    def sample(self, text, at=0, failure=None):
        return u_sample.sample(self.runner(text, failure), now=NOW+dt.timedelta(seconds=at), clock=lambda: .03)

    def events(self, name=None):
        result = [json.loads(line) for p in sorted(self.root.glob('*.ndjson')) for line in p.read_text().splitlines()]
        return [r for r in result if name is None or r['name'] == name]

    def qualify(self, text, at=0):
        self.sample(text, at)
        return self.sample(text, at+60)

    def test_empty_and_thirty_second_blip_are_silent(self):
        self.assertIsNone(self.sample(snapshot()))
        self.assertIsNone(self.sample(snapshot(row(age='00:30')), 60))
        self.assertIsNone(self.sample(snapshot(), 120))
        self.assertEqual(self.events(), [])
        self.assertEqual(len(self.calls), 3)

    def test_old_process_needs_observed_u_minute_and_resets_on_sleep_or_pid_reuse(self):
        self.assertIsNone(self.sample(snapshot(row(age='1-00:00:00'))))
        self.assertEqual(self.sample(snapshot(row(age='1-00:00:00')), 60)['count'], 1)
        for at, proc in [(120, row(stat='S')), (180, row()),
                         (240, row(start='Sun Nov 15 09:30:00 2026')),
                         (600, row()), (590, row())]:
            with self.subTest(at=at):
                self.assertIsNone(self.sample(snapshot(proc), at))

    def test_lsof_twelve_under_three_parents(self):
        parents = [row(pid=p, ppid=1, stat='S', comm='/usr/bin/python3', args='python3 runner.py '+'x'*300) for p in (100, 101, 102)]
        text = snapshot(*parents, *[row(pid=200+i, ppid=100+i%3, args='lsof -nP -iTCP:123 -sTCP:LISTEN -t '+'y'*300) for i in range(12)])
        props = self.qualify(text)
        self.assertEqual(props['lsofStuck'], 12)
        self.assertEqual(props['byComm'], {'lsof': 12})
        self.assertEqual([(p['parentPid'], p['n']) for p in props['lsofCallers']], [(100, 4), (101, 4), (102, 4)])
        self.assertEqual(len(props['procs']), 12)
        for proc in props['procs']:
            self.assertEqual(proc['parentComm'], 'python3')
            self.assertEqual(len(proc['parentArgs']), 200)
            self.assertEqual(len(proc['args']), 200)
            self.assertEqual(proc['ageS'], 600)
            self.assertEqual(proc['cpuS'], 1.23)
            self.assertIsNone(proc['volume'])
        self.assertTrue(all(len(c['parentArgs']) == 200 for c in props['lsofCallers']))
        self.assertEqual(self.events()[0]['props'], props)

    def test_volume_hints_and_comm_spaces_and_missing_parent(self):
        cases = [('ls /Volumes/ExternalSSD/path', '/Volumes/ExternalSSD'),
                 ('ls /var/folders/aa/path', '/var/folders'),
                 ('ls /Users/ardud/project', '/Users/ardud'),
                 ('ls /var/folders/x /Volumes/ExternalSSD/y', '/var/folders'),
                 ('lsof -iTCP:80', None)]
        for args, expected in cases:
            with self.subTest(args=args):
                self.assertEqual(u_sample.volume(args), expected)
        text = snapshot(row(comm='/Applications/Robob Helper (Renderer)', args='ls /Volumes/ExternalSSD/path', ppid=999))
        proc = self.qualify(text)['procs'][0]
        self.assertEqual(proc['comm'], 'Robob Helper (Renderer)')
        self.assertEqual(proc['volume'], '/Volumes/ExternalSSD')
        self.assertIsNone(proc['parentComm'])
        self.assertIsNone(proc['parentArgs'])

    def test_known_umount_once_per_utc_day_including_restart(self):
        text = snapshot(row(pid=99184, comm='/sbin/umount', age='4-00:00:00', args='umount -f /Users/ardud/checkouts'))
        self.assertEqual(self.qualify(text, 14*3600-180)['procs'][0]['pid'], 99184)
        importlib.reload(u_sample)
        props = self.sample(text, 14*3600-60)
        self.assertEqual(props['count'], 1)
        self.assertEqual(props['byComm'], {'umount': 1})
        self.assertEqual(props['procs'], [])
        self.sample(text, 14*3600)
        samples = self.events('proc.u_sample')
        included = [r for r in samples if r['props']['procs']]
        self.assertEqual([r['ts'][:10] for r in included], ['2026-11-15', '2026-11-16'])

    def test_failures_record_error_leave_state_and_do_not_stop_cpu_entrypoint(self):
        self.qualify(snapshot(row()))
        before = (self.root/'state/proc-u.json').read_bytes()
        for failure in ('timeout', 'exit', 'parse', 'unavailable'):
            with self.subTest(failure=failure):
                props = self.sample('invalid', 120, failure)
                self.assertEqual(props, dict(failure=failure))
                event = self.events()[-1]
                self.assertEqual(event['kind'], 'error')
                self.assertFalse(event['ok'])
                self.assertNotIn('private', json.dumps(event))
                self.assertEqual((self.root/'state/proc-u.json').read_bytes(), before)
        with patch.object(u_sample, 'sample', side_effect=RuntimeError('private')), patch.object(cpu, 'sample') as cpu_probe:
            cpu.main()
        cpu_probe.assert_called_once_with()

    def test_episodes_open_three_empty_close_and_rollup(self):
        first = snapshot(row(args='ls /Volumes/ExternalSSD/path', comm='/bin/ls'))
        self.qualify(first)
        props = self.sample(snapshot(row(args='ls /Volumes/ExternalSSD/path', comm='/bin/ls'), row(pid=11, args='lsof /var/folders/x')), 120)
        self.assertEqual(props['episode']['peakCount'], 1)  # new PID still on probation
        self.sample(snapshot(row(args='ls /Volumes/ExternalSSD/path', comm='/bin/ls'), row(pid=11, args='lsof /var/folders/x')), 180)
        for at in (240, 300):
            self.assertIsNone(self.sample(snapshot(), at))
            self.assertEqual(self.events('proc.u_episode'), [])
        self.sample(snapshot(), 360)
        self.assertEqual(len(self.events('proc.u_episode')), 1)
        episode = rollup('2026-11-15', self.root)['uEpisodes'][0]
        self.assertEqual(episode['start'], (NOW+dt.timedelta(seconds=60)).timestamp())
        self.assertEqual(episode['end'], (NOW+dt.timedelta(seconds=360)).timestamp())
        self.assertEqual(episode['peakCount'], 2)
        self.assertEqual(episode['volumes'], ['/Volumes/ExternalSSD', '/var/folders'])
        self.assertEqual(episode['topComms'], [dict(comm='ls', count=1), dict(comm='lsof', count=1)])
        self.assertEqual(jobs.read_state('proc-u')['episode'], {})
        self.sample(snapshot(), 420)
        self.qualify(first, 480)
        episodes = rollup('2026-11-15', self.root)['uEpisodes']
        self.assertEqual(len(episodes), 2)
        self.assertIsNone(episodes[-1]['end'])

    def test_restart_keeps_u_observation_and_partial_empty_streak(self):
        self.sample(snapshot(row()))
        importlib.reload(u_sample)
        with patch('time.monotonic', return_value=.001):
            self.assertEqual(self.sample(snapshot(row()), 60)['count'], 1)
        self.sample(snapshot(), 120)
        importlib.reload(u_sample)
        self.sample(snapshot(), 180)
        self.sample(snapshot(), 240)
        self.assertEqual(len(self.events('proc.u_episode')), 1)
        saved = jobs.read_state('proc-u')
        self.assertGreater(saved['at'], 1_700_000_000)
        self.assertNotIn('monotonic', json.dumps(saved))
        self.assertLess((self.root/'state/proc-u.json').stat().st_size, 512)

    def test_episode_spanning_midnight_appears_in_both_day_rollups(self):
        at = 14*3600-180
        self.qualify(snapshot(row(age='1-00:00:00')), at)
        self.sample(snapshot(), at+120)
        self.sample(snapshot(), at+180)
        self.sample(snapshot(), at+240)
        first = rollup('2026-11-15', self.root)['uEpisodes'][0]
        second = rollup('2026-11-16', self.root)['uEpisodes'][0]
        self.assertIsNone(first['end'])
        self.assertEqual(second['start'], first['start'])
        self.assertEqual(second['end'], (NOW+dt.timedelta(seconds=at+240)).timestamp())
        self.assertEqual(second['peakCount'], 1)

    def test_nonempty_between_empty_samples_resets_streak(self):
        text = snapshot(row())
        self.qualify(text)
        self.sample(snapshot(), 120)
        self.sample(text, 180)
        self.sample(text, 240)
        self.sample(snapshot(), 300)
        self.sample(snapshot(), 360)
        self.assertEqual(self.events('proc.u_episode'), [])
        self.sample(snapshot(), 420)
        self.assertEqual(len(self.events('proc.u_episode')), 1)

    def test_parse_form_matrix(self):
        for age, cpu_time, expected_age, expected_cpu in [
                ('01:00', '0:01.23', 60, 1.23), ('01:02:03', '1:02:03', 3723, 3723),
                ('2-03:04:05', '2-03:04:05.12', 183845, 183845.12)]:
            with self.subTest(age=age):
                proc = u_sample.parse_ps(snapshot(row(age=age, cpu_time=cpu_time)))[10]
                self.assertEqual(proc['ageS'], expected_age)
                self.assertAlmostEqual(proc['cpuS'], expected_cpu)
        for text in ('', 'invalid', snapshot(row(start='bad')),
                     snapshot(row(cpu_time='NaN')), snapshot(row(age='1:60')), snapshot(row(stat='!!!'))):
            with self.subTest(text=text), self.assertRaises(cpu.ProbeError):
                u_sample.parse_ps(text)

    def test_exiting_and_torn_rows_do_not_lose_valid_observations(self):
        for stat in ('?', '?E', '?s', '?N'):
            with self.subTest(stat=stat):
                proc = u_sample.parse_ps(snapshot(row(stat=stat, comm='(Python)')))[10]
                self.assertEqual(proc['comm'], 'Python')
        text = snapshot(row(), row(pid=20, start='bad', args='private argv'))
        props = self.qualify(text)
        self.assertEqual(props['count'], 1)
        diagnostic = self.events('proc.u_parse')[-1]['props']
        self.assertEqual(diagnostic['skippedRows'], 1)
        self.assertNotIn('private argv', json.dumps(diagnostic))
        # A partial inventory cannot prove an empty minute and close an episode.
        for at in (120, 180, 240):
            self.sample(snapshot(row(stat='S'), row(pid=20, start='bad')), at)
        self.assertEqual(self.events('proc.u_episode'), [])
        for text in (snapshot(*[row(pid=i, start='bad') for i in range(6)], row()),
                     snapshot(row(start='bad'))):
            with self.subTest(text=text), self.assertRaises(cpu.ProbeError):
                u_sample.parse_ps(text)

    def test_caps_and_redaction_and_all_processes_contribute_to_episode(self):
        text = snapshot(*[row(pid=100+i, ppid=200+i, comm='/bin/lsof', args='lsof /Volumes/Disk%d/x'%i) for i in range(20)])
        props = self.qualify(text)
        self.assertEqual(len(props['procs']), 15)
        self.assertEqual(props['count'], 20)
        self.assertEqual(props['lsofStuck'], 20)
        self.assertEqual(len(props['lsofCallers']), 5)
        self.assertEqual(props['episode']['peakCount'], 20)
        self.assertEqual(len(props['episode']['volumes']), 15)
        proc = dict(pid=1, ppid=0, ageS=120, cpuS=1, stat='U', comm='界'*80,
                    parentComm='界'*80, args='界'*200, parentArgs='界'*200, volume='/Volumes/'+'界'*128)
        hostile = dict(count=999, lsofStuck=999, procs=[proc]*15,
                       byComm={str(i)+'界'*80: i for i in range(100)},
                       lsofCallers=[dict(parentPid=i, n=i, parentArgs='界'*200) for i in range(5)],
                       episode=dict(start=1, lastSeen=2, peakCount=999, end=None,
                                    volumes=['界'*128]*15, topComms=[dict(comm='界'*80, count=1)]*10))
        event = toollog.record('proc', 'event', 'proc.u_sample', NOW, props=hostile)
        self.assertLessEqual(len((json.dumps(event, separators=(',', ':'))+'\n').encode()), 16384)
        self.assertEqual(event['props']['count'], 999)
        event = toollog.record('proc', 'event', 'proc.u_episode', NOW, props=hostile['episode'])
        self.assertLessEqual(len((json.dumps(event, separators=(',', ':'))+'\n').encode()), 16384)
        cleaned = toollog.u_sample_fields(dict(procs=[dict(proc, args='lsof --token=private', parentArgs='password=private')]))
        self.assertNotIn('private', json.dumps(cleaned))
        self.assertEqual(toollog.safe_fields(hostile, 'unrelated'), {'count': 999})

    def test_corrupt_state_lock_and_failed_append_retry(self):
        jobs.state_path('proc-u').write_text('{bad')
        self.assertIsNone(self.sample(snapshot(row())))
        with jobs.state_path('proc-u').with_suffix('.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            before = len(self.calls)
            self.assertIsNone(self.sample(snapshot(row()), 60))
            self.assertEqual(len(self.calls), before)
        self.sample(snapshot(row()), 60)
        self.sample(snapshot(), 120)
        self.sample(snapshot(), 180)
        with patch.object(u_sample, 'emit', return_value=False):
            self.sample(snapshot(), 240)
        self.assertIsNotNone(jobs.read_state('proc-u')['episode']['end'])
        importlib.reload(u_sample)
        self.sample(snapshot(), 300)
        self.assertEqual(len(self.events('proc.u_episode')), 1)

    def test_shared_schedule_and_installer(self):
        plist = plistlib.loads((HERE/'launchd/com.abdullah.mac-cpu.plist').read_bytes())
        self.assertEqual(plist['StartInterval'], 60)
        self.assertIn('cpu.py', plist['ProgramArguments'][-1])
        self.assertIn('u_sample.py', (HERE/'install.zsh').read_text())


if __name__ == '__main__':
    unittest.main()

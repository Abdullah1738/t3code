import copy
import json
import os
import plistlib
from pathlib import Path
import subprocess
import tempfile
import time
import signal
import sys
import unittest
from unittest.mock import patch, Mock

import protected_tier as tier
from protected_native import decode_argv, apply_checked


def row(pid, argv, ppid=1, nice=0, pri=20):
    return dict(pid=pid, ppid=ppid, uid=os.getuid(), start=[1700000000, pid],
                lstart='Tue Nov 14 22:13:20 2023', nice=nice, pri=pri, argv=argv)


class FakeNative:
    def __init__(self, rows):
        self.rows = {r['pid']: copy.deepcopy(r) for r in rows}

    def inventory(self):
        return copy.deepcopy(self.rows)

    def read(self, pid):
        return copy.deepcopy(self.rows[pid])


class Matching(unittest.TestCase):
    def setUp(self):
        self.rules = tier.config(Path('/Users/ardud'))

    def test_every_root_label_hit_and_exact_fallback(self):
        for i, rule in enumerate(self.rules['roots']):
            for labels in ({}, {rule['label']: i+10}):
                with self.subTest(label=rule['label'], labels=labels):
                    r = row(i+10, rule['argv'])
                    self.assertEqual([x['pid'] for x in tier.select({r['pid']: r}, labels, self.rules)], [r['pid']])

    def test_rejected_class(self):
        rule = self.rules['roots'][2]
        base = row(20, rule['argv'])
        forms = [dict(argv=['/bin/zsh', '-c', ' '.join(rule['argv'])]),
                 dict(argv=[rule['argv'][0], rule['argv'][1]+'.bak']),
                 dict(argv=[rule['argv'][0], '-e', rule['argv'][1]]),
                 dict(argv=[rule['argv'][0], '/Applications/Robob.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs']),
                 dict(argv=['/usr/bin/opencode', 'serve']), dict(argv=['/System/Library/Finder.app']),
                 dict(uid=os.getuid()+1), dict(ppid=10), dict(pid=1)]
        for fields in forms:
            r = dict(base, **fields)
            with self.subTest(fields=fields):
                self.assertEqual(tier.select({r['pid']: r}, {}, self.rules), [])
        self.assertEqual(tier.select({20: base}, {rule['label']: 21}, self.rules), [])
        self.assertEqual(tier.select({20: row(20, ['/bin/sleep','20'])}, {rule['label']: 20}, self.rules), [])

    def test_ambiguous_fallback_rejected_but_label_disambiguates(self):
        rule = self.rules['roots'][2]
        rows = {20:row(20,rule['argv']), 21:row(21,rule['argv'])}
        self.assertEqual(tier.select(rows,{},self.rules), [])
        self.assertEqual([r['pid'] for r in tier.select(rows,{rule['label']:20},self.rules)], [20])

    def test_bridge_children_need_exact_live_supervisor(self):
        parent = row(20, self.rules['roots'][3]['argv'])
        for rule in self.rules['children']:
            child = row(21, rule['argv'], ppid=20)
            with self.subTest(child=rule['label']):
                self.assertEqual(len(tier.select({20: parent, 21: child}, {}, self.rules)), 2)
                self.assertEqual(tier.select({21: child}, {}, self.rules), [])
                self.assertEqual(len(tier.select({20: parent, 21: dict(child,ppid=22)}, {}, self.rules)), 1)


class Adjustments(unittest.TestCase):
    def setUp(self):
        self.r = dict(row(20, ['/bin/service']), label='helper', matched_by='label')
        self.native = FakeNative([self.r])
        self.events = []

    def set_nice(self, native, r):
        native.rows[r['pid']]['nice'] = -5

    def run_command(self, argv):
        if argv[0] == '/bin/ps':
            return str(self.native.rows[20]['pri'])
        self.assertEqual(argv[0:2], ['/usr/bin/python3','-I'])
        self.assertEqual(argv[3], 'background')
        self.native.rows[20]['pri'] = 20
        return ''

    def adjust(self, **kwargs):
        return tier.adjust(self.native, self.r, kwargs.get('run', self.run_command),
                           kwargs.get('nice', self.set_nice), self.events.append)

    def test_drift_matrix_and_steady_state(self):
        for nice, pri, expected in [(-5,20,[]),(-10,20,[]),(0,20,['nice-drift']),
                                    (-5,4,['background-policy']),(0,4,['background-policy','nice-drift'])]:
            with self.subTest(nice=nice, pri=pri):
                self.native.rows[20].update(nice=nice, pri=pri)
                self.events.clear()
                self.assertEqual(self.adjust(), expected)
                self.assertEqual(len(self.events), len(expected))
                nofork = Mock(side_effect=AssertionError('steady state fork'))
                self.assertEqual(self.adjust(run=nofork, nice=nofork), [])

    def test_start_uid_parent_argv_changes_fail_closed(self):
        for fields in [dict(start=[1700000000,99]),dict(uid=os.getuid()+1),dict(ppid=2),dict(argv=['other'])]:
            with self.subTest(fields=fields):
                self.native.rows[20] = dict(self.r, **fields)
                run = Mock()
                with self.assertRaises(ValueError):
                    self.adjust(run=run, nice=run)
                run.assert_not_called()

    def test_supervisor_reuse_rejected(self):
        parent = row(10, ['/bin/supervisor'])
        self.r.update(parent=parent, ppid=10)
        self.native.rows[20] = copy.deepcopy(self.r)
        self.native.rows[10] = dict(parent, start=[1,2])
        with self.assertRaises(ValueError):
            self.adjust()

    def test_timeout_preserves_completed_adjustment(self):
        self.native.rows[20]['pri'] = 4
        with self.assertRaises(subprocess.TimeoutExpired):
            self.adjust(nice=Mock(side_effect=subprocess.TimeoutExpired('sudo',10)))
        self.assertEqual(self.events[0]['reason'], 'background-policy')

    def test_successful_action_is_logged_when_readback_disappears(self):
        for reason in ('background-policy', 'nice-drift'):
            with self.subTest(reason=reason):
                self.setUp()
                if reason == 'background-policy':
                    self.native.rows[20]['pri'] = 4
                def disappear(*args):
                    self.native.read = Mock(side_effect=OSError('exited'))
                    return ''
                def run(argv):
                    return '4' if argv[0] == '/bin/ps' else disappear()
                with self.assertRaises(OSError):
                    self.adjust(run=run, nice=disappear)
                event = self.events[0]
                self.assertEqual(event['reason'], reason)
                self.assertEqual(event['outcome'], 'command-succeeded')
                self.assertEqual(event['after'], dict(nice=None,pri=None))
                self.assertEqual(event['readback_error'], 'OSError')

    def test_ps_timeout_no_mutation(self):
        self.native.rows[20]['pri'] = 4
        nice = Mock()
        with self.assertRaises(subprocess.TimeoutExpired):
            self.adjust(run=Mock(side_effect=subprocess.TimeoutExpired('ps',10)),nice=nice)
        nice.assert_not_called()

    def test_command_timeout_and_safe_error(self):
        with patch.object(tier.subprocess, 'run', return_value=Mock(returncode=1,stderr=b'SECRET')) as run:
            with self.assertRaisesRegex(RuntimeError, '^command exit 1$'):
                tier.command(['/bin/false'])
            self.assertEqual(run.call_args.kwargs['timeout'], 10)

    def test_credential_pipe_timeout_reaps_producer(self):
        producer = Mock()
        producer.poll.return_value = None
        with patch.object(tier.subprocess, 'Popen', return_value=producer), patch.object(
                tier.subprocess, 'run', side_effect=subprocess.TimeoutExpired('sudo',10)) as run:
            with self.assertRaises(subprocess.TimeoutExpired):
                tier.renice(self.native, self.r)
        producer.kill.assert_called_once()
        producer.wait.assert_called_with(timeout=10)
        self.assertIs(run.call_args.kwargs['stdin'], producer.stdout)
        self.assertEqual(run.call_args.kwargs['timeout'],10)
        self.assertIn('-k', run.call_args.args[0])

    def test_deadline_rejects_expired_and_invalid_forms(self):
        import protected_native
        for deadline in (99, 100, float('nan'), float('inf'), 111):
            with self.subTest(deadline=deadline), patch.object(protected_native.time,'time',return_value=100):
                with self.assertRaises(TimeoutError):
                    protected_native.remaining_deadline(deadline)
        with patch.object(protected_native.time,'time',return_value=100):
            self.assertEqual(protected_native.remaining_deadline(100.5), .5)

    def test_deadline_expiring_during_identity_read_blocks_exec(self):
        import protected_native
        with patch.object(protected_native,'Native',return_value=self.native), patch.object(protected_native.os,'execv') as execute, patch.object(protected_native.time,'time',side_effect=[100,111]):
            with self.assertRaises(TimeoutError):
                apply_checked('nice',json.dumps(self.r),110)
            execute.assert_not_called()

    def test_alarm_kills_execed_utility_without_parent_cleanup(self):
        code = ("import os,sys,time; sys.path.insert(0,sys.argv[1]); "
                "from protected_native import arm_deadline; arm_deadline(time.time()+.05); "
                "os.execv('/bin/sleep',['sleep','30'])")
        result = subprocess.run([sys.executable,'-I','-c',code,str(Path(__file__).resolve().parent)],timeout=10)
        self.assertEqual(result.returncode,-signal.SIGALRM)

    def test_darwin_nice_increment_reaches_target(self):
        import protected_native
        for nice in (-4, 0, 10):
            with self.subTest(nice=nice):
                self.native.rows[20]['nice'] = nice
                with patch.object(protected_native,'Native',return_value=self.native), patch.object(protected_native.os,'execv') as execute:
                    apply_checked('nice', json.dumps(self.r), time.time()+10)
                    self.assertEqual(execute.call_args.args[1], ['renice','-n',str(-5-nice),'-p','20'])

    def test_native_background_gate_and_binary(self):
        import protected_native
        with patch.object(protected_native,'Native',return_value=self.native), patch.object(protected_native.os,'execv') as execute:
            self.native.rows[20]['pri']=4
            apply_checked('background',json.dumps(self.r), time.time()+10)
            self.assertEqual(execute.call_args.args,('/usr/sbin/taskpolicy',['taskpolicy','-B','-p','20']))
            execute.reset_mock()
            self.native.rows[20]['pri']=20
            apply_checked('background',json.dumps(self.r), time.time()+10)
            execute.assert_not_called()

    def test_post_auth_helper_rechecks_reused_pid(self):
        import protected_native
        self.native.rows[20]['start'] = [1,2]
        with patch.object(protected_native,'Native',return_value=self.native), patch.object(protected_native.os,'execv') as execute:
            with self.assertRaises(ValueError):
                apply_checked('nice', json.dumps(self.r), time.time()+10)
            execute.assert_not_called()


class Ticks(unittest.TestCase):
    def test_cache_no_forks_and_restart_refresh(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            root = home / '.local/state/robob-guard'
            root.mkdir(parents=True)
            rules = tier.config(home)
            n = FakeNative([row(20,rules['roots'][2]['argv'],nice=-5)])
            labels = Mock(return_value={'com.ardud.robob-watch':20})
            nofork = Mock(side_effect=AssertionError('unexpected fork'))
            tier.tick(home,n,labels,nofork,nofork)
            tier.tick(home,n,labels,nofork,nofork)
            self.assertEqual(labels.call_count,1)
            n.rows[20]['start'][1] += 1
            tier.tick(home,n,labels,nofork,nofork)
            self.assertEqual(labels.call_count,2)
            events = [json.loads(x) for x in (root/'guard.log').read_text().splitlines()]
            self.assertTrue(all(x['event']=='protected_tier.tick' for x in events))
            self.assertTrue(all(x['issues'] for x in events))

    def test_discovery_timeout_logged(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            root = home / '.local/state/robob-guard'
            root.mkdir(parents=True)
            tier.tick(home,FakeNative([]),Mock(side_effect=subprocess.TimeoutExpired('launchctl',10)))
            event = json.loads((root/'guard.log').read_text())
            self.assertEqual(event['issues'][0]['reason'],'TimeoutExpired')

    def test_launchctl_timeout_still_protects_exact_argv(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            root = home / '.local/state/robob-guard'
            root.mkdir(parents=True)
            r = row(20,tier.config(home)['roots'][2]['argv'])
            n = FakeNative([r])
            def nice(native, row):
                native.rows[row['pid']]['nice'] = -5
            tier.tick(home,n,Mock(side_effect=subprocess.TimeoutExpired('launchctl',10)),Mock(),nice)
            self.assertEqual(n.rows[20]['nice'],-5)
            events = [json.loads(line) for line in (root/'guard.log').read_text().splitlines()]
            self.assertEqual(events[0]['event'],'protected_tier.adjust')
            self.assertEqual(events[-1]['issues'][0]['fallback'],'exact-argv')

    def test_interval_guard_starts_in_protected_tier(self):
        plist = plistlib.loads(Path('scripts/com.ardud.robob-guard.plist').read_bytes())
        self.assertEqual(plist['Nice'],-5)
        self.assertEqual(plist['ProcessType'],'Interactive')
        self.assertEqual(plist['StartInterval'],30)

    def test_decode_argv_preserves_empty_and_excludes_environment(self):
        raw = (3).to_bytes(4,'little',signed=True)+b'/bin/a\0\0'+b'/bin/a\0\0arg\0SECRET=value\0'
        self.assertEqual(decode_argv(raw), ['/bin/a','','arg'])


if __name__ == '__main__':
    unittest.main()

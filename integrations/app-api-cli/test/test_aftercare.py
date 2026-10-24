import io
import json
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import aftercare as a
import order_tracker as t

SESSION = 'ardud-control:thread:test'
ADD = ['add', '--app', 'noon', '--order', 'NAEIA0072787151', '--for', 'moni',
       '--item', 'TONEOF 173cm phone stand', '--amount', 'AED 79', '--refund-to', 'card 5542',
       '--blocker', 'pickup dates only ran to 25 Oct', '--next-at', '2026-10-24T09:00:00+04:00',
       '--constraint', 'pickup on or after 27 Oct', '--deadline', '2026-11-06']
CID = 'aftercare-noon-naeia0072787151-return'


class AftercareTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.watchers = self.tmp / 'watchers'
        for name, value in (('ROOT', self.tmp / 'aftercare'), ('WATCHERS', self.watchers)):
            p = mock.patch.object(a, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.calls = []

        self.specs = []

        def run(args, timeout=30, stdin=None):
            # Like robob-watch: --replace keeps the state, a new watcher starts active.
            self.calls.append(args)
            if args[1] == 'add':
                self.assertEqual(args[2:4], ['--json', '-'])
                spec = json.loads(stdin)
                self.specs.append(spec)
                d = self.watchers / spec['id']
                if (d / 'watcher.json').exists() and '--replace' not in args:
                    raise RuntimeError('robob-watch add failed: exists; use --replace')
                d.mkdir(parents=True, exist_ok=True)
                (d / 'watcher.json').write_text(json.dumps(spec))
                if not (d / 'state.json').exists():
                    (d / 'state.json').write_text('{"status": "active"}')
            elif args[1] == 'resume':
                (self.watchers / args[2] / 'state.json').write_text('{"status": "active"}')
            elif args[1] == 'remove':
                d = self.watchers / args[2]
                d.rename(self.tmp / f'archived-{args[2]}-{len(self.calls)}')
            return ''
        p = mock.patch.object(a, 'run', run)
        p.start()
        self.addCleanup(p.stop)

    def cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            try:
                code = a.main(list(argv), session=SESSION)
            except SystemExit as e:
                code = e.code
        return code, out.getvalue(), err.getvalue()

    def case(self):
        return json.loads((self.tmp / 'aftercare' / f'{CID}.json').read_text())

    def test_case_id_fits_a_watcher_id(self):
        self.assertEqual(a.case_id('noon', 'NAEIA0072787151', 'return'), CID)
        long = a.case_id('amazon', '408-1234567-1234567-ABCDEFGHIJ', 'follow-up')
        self.assertLessEqual(len(long), 48)
        self.assertRegex(long, r'^[a-z0-9][a-z0-9-]{0,47}$')
        self.assertNotEqual(long, a.case_id('amazon', '408-1234567-1234567-ABCDEFGHIK', 'follow-up'))
        # Order ids that only differ in what the watcher id can't hold never share a case.
        ids = {a.case_id('noon', o, 'return') for o in ('A_B', 'A-B', 'a-b', 'A.B', 'A B')}
        self.assertEqual(len(ids), 5)
        for cid in ids:
            self.assertRegex(cid, r'^[a-z0-9][a-z0-9-]{0,47}$')

    def test_add_saves_the_case_and_registers_one_wake_watcher(self):
        code, out, _ = self.cli(*ADD, '--request', 'Moni: ok it and the return too')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {'case': CID, 'status': 'open',
                                           'next_at': '2026-10-24T09:00:00+04:00', 'watcher': 'active'})
        case = self.case()
        self.assertEqual((case['status'], case['for'], case['session']), ('open', 'moni', SESSION))
        self.assertEqual(case['deadline'], '2026-11-06T23:59:00+04:00')
        self.assertEqual(case['history'][0]['event'], 'opened')
        [add] = self.calls
        [spec] = self.specs
        self.assertEqual(add[:2], ['robob-watch', 'add'])
        self.assertEqual((spec['id'], spec['mode'], spec['max_fires'], spec['created_by_session']),
                         (CID, 'wake', 0, SESSION))
        self.assertIn('--no-prime', add, 'a prime run would race the runner on the state file')
        self.assertTrue(spec['check'].endswith(f'aftercare.py check --id {CID} --gen 1'))
        self.assertIsNone(spec['expires_at'], 'an open case keeps its wake until close or drop')
        context = spec['context']
        for phrase in ('Never place, cancel or change an order', 'close the case with that reference',
                       'Banyantree Flat 2104', 'pickup on or after 27 Oct', 'refund to card 5542',
                       f'--key {CID}-g1-closed', 'Never via imsg', 'Never say it is booked or refunded'):
            self.assertIn(phrase, context)
        self.assertEqual(oct_mode(self.tmp / 'aftercare' / f'{CID}.json'), 0o600)

    def test_add_refuses_what_it_cannot_hold(self):
        code, _, err = self.cli(*[x for x in ADD if x not in ('--blocker', 'pickup dates only ran to 25 Oct')])
        self.assertEqual(code, 2)
        self.assertIn('should just be done', err)
        bad = list(ADD)
        bad[bad.index('--next-at') + 1] = '2026-10-24T09:00:00'
        self.assertIn('timezone', self.cli(*bad)[2])
        late = list(ADD)
        late[late.index('--next-at') + 1] = '2026-11-08T09:00:00+04:00'
        self.assertIn('after the deadline', self.cli(*late)[2])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.cli(*ADD)[0], 0)
        self.assertIn('already open', self.cli(*ADD)[2])

    def test_update_moves_the_try_and_rearms_an_expired_watcher(self):
        self.cli(*ADD)
        self.assertEqual(self.cli('update', '--id', CID, '--next-at', '2026-10-25T09:00:00+04:00',
                                  '--blocker', 'still only to 26 Oct')[0], 0)
        self.assertEqual(self.calls[-1][:2], ['robob-watch', 'add'])
        self.assertIn('--replace', self.calls[-1])
        (self.watchers / CID / 'state.json').write_text('{"status": "expired"}')
        self.assertIn('WATCHER EXPIRED', self.cli('list')[1])
        self.cli('update', '--id', CID, '--note', 'checked again')
        self.assertEqual(self.calls[-1][:3], ['robob-watch', 'resume', CID])
        self.assertNotIn('WATCHER', self.cli('list')[1])
        case = self.case()
        self.assertEqual((case['blocker'], case['next_at']), ('still only to 26 Oct', '2026-10-25T09:00:00+04:00'))
        self.assertEqual([h['event'] for h in case['history']], ['opened', 'updated', 'updated'])
        self.assertIn('needs --blocker', self.cli('update', '--id', CID)[2])

    def test_an_open_case_never_loses_its_wake_however_long_nobody_touches_it(self):
        no_deadline = ADD[:ADD.index('--deadline')]
        no_deadline[no_deadline.index('--next-at') + 1] = '2026-12-01T09:00:00+04:00'
        self.cli(*no_deadline)
        self.cli('update', '--id', CID, '--next-at', '2027-01-10T09:00:00+04:00', '--blocker', 'away')
        self.cli('update', '--id', CID, '--deadline', '2027-02-01')
        self.assertEqual([s['expires_at'] for s in self.specs], [None, None, None])
        self.assertEqual(json.loads((self.watchers / CID / 'watcher.json').read_text())['expires_at'], None)
        self.assertNotIn('watch_until', self.case())
        # Months later, untouched: still due, daily, and past the deadline it says to tell Abdullah.
        out = a.check(CID, {}, a.epoch('2027-06-03T09:00:00+04:00'))
        self.assertIn('has passed: tell Abdullah now', out)
        self.assertEqual(self.cli('show', '--id', CID)[1].count('"watcher": "active"'), 1)

    def test_a_reopened_case_gets_its_own_watcher_and_completion_key(self):
        self.cli(*ADD)
        self.cli('drop', '--id', CID, '--reason', 'Moni is keeping it')
        self.specs.clear()
        self.cli(*ADD)
        [spec] = self.specs
        wid = a.watcher_id(self.case())
        self.assertNotEqual(wid, CID, 'a new round never shares the old watcher (or its fire count)')
        self.assertRegex(wid, r'^[a-z0-9][a-z0-9-]{0,47}$')
        self.assertEqual(spec['id'], wid)
        self.assertTrue(spec['check'].endswith(f'--id {CID} --gen 2'))
        self.assertIn(f'--key {CID}-g2-closed', spec['context'])
        self.assertEqual((self.case()['gen'], self.case()['armed'], self.case()['watcher_id']), (2, 2, wid))
        due = a.epoch('2026-10-24T09:00:00+04:00')
        self.assertEqual(a.check(CID, {}, due, gen=1), '', 'a watcher from the dropped case stays quiet')
        second = a.check(CID, {}, due, gen=2)
        self.assertIn(f'(round 2, due Sat 24 Oct 09:00)', second)
        self.cli('drop', '--id', CID, '--reason', 'x')
        self.assertFalse((self.watchers / wid).exists())

    def test_a_watcher_a_failed_removal_left_is_shown_quiet_and_cleaned_up(self):
        self.cli(*ADD)
        with mock.patch.object(a, 'run', side_effect=RuntimeError('robob-watch remove failed: boom')):
            self.assertEqual(self.cli('drop', '--id', CID, '--reason', 'x')[0], 1)
        self.assertTrue((self.watchers / CID / 'watcher.json').exists(), 'round 1 watcher left behind')
        with mock.patch.object(a, 'run', side_effect=RuntimeError('robob-watch add failed: boom')):
            self.assertEqual(self.cli(*ADD)[0], 1)
        self.assertIn('WATCHER MISSING', self.cli('list')[1])
        self.assertEqual(a.check(CID, {}, a.epoch('2026-10-24T09:00:00+04:00'), gen=1), '')
        self.assertEqual(self.cli('update', '--id', CID, '--note', 'retry')[0], 0)
        self.assertFalse((self.watchers / CID).exists(), 'the next change removes the old round')
        self.assertTrue((self.watchers / a.watcher_id(self.case()) / 'watcher.json').exists())
        self.assertNotIn('WATCHER', self.cli('list')[1])

    def test_a_check_never_prints_a_wake_for_a_case_that_changed_under_it(self):
        self.cli(*ADD)
        due = a.epoch('2026-10-24T09:00:00+04:00')
        wdir = self.tmp / 'w'
        wdir.mkdir()
        env = {'WATCH_DIR': str(wdir), 'WATCH_RUN': 'r1'}
        # A close holds the case lock (as mutate does) while the check runs: the check waits, then
        # reads the closed case and stays quiet instead of printing the stale wake.
        held, done, out = threading.Event(), threading.Event(), []
        import fcntl

        def closer():
            with (a.ROOT / '.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                held.set()
                time.sleep(0.5)
                case = self.case()
                case['status'] = 'closed'
                a.write(a.path_for(CID), case)
            done.set()
        th = threading.Thread(target=closer)
        th.start()
        held.wait()
        out.append(a.check(CID, env, due, gen=1))
        th.join()
        self.assertTrue(done.is_set())
        self.assertEqual(out, [''])
        self.assertFalse((wdir / 'aftercare-state.json').exists())
        # A change that holds the lock past the wait leaves the check quiet; the next run tries again.
        with mock.patch.object(a, 'CHECK_LOCK_WAIT_S', 0.3), (a.ROOT / '.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            started = time.monotonic()
            self.assertEqual(a.check(CID, env, due, gen=1), '')
            self.assertLess(time.monotonic() - started, 2)

    def test_one_case_file_never_serves_another_order(self):
        self.cli(*ADD)
        case = self.case()
        case['order'] = 'NAEIA0072787151X'  # what a sanitizing collision would have left
        (self.tmp / 'aftercare' / f'{CID}.json').write_text(json.dumps(case))
        code, _, err = self.cli('update', '--app', 'noon', '--order', 'NAEIA0072787151', '--note', 'x')
        self.assertEqual(code, 2)
        self.assertIn('belongs to noon order NAEIA0072787151X', err)

    def test_wake_context_stays_inside_the_watcher_limit(self):
        many = [x for i in range(11) for x in ('--item', f'item {i}')]
        self.assertIn('at most 10 --item', self.cli(*ADD, *many[2:])[2])
        long = [x for i in range(10) for x in ('--item', f'{i} ' + 'very long item name ' * 7)]
        self.assertEqual(self.cli(*ADD[:ADD.index('--item')], *ADD[ADD.index('--item') + 2:], *long,
                                  '--request', 'r' * 400)[0], 0)
        [spec] = self.specs
        self.assertLessEqual(len(spec['context']), a.CONTEXT_LIMIT)
        self.assertIn('and 9 more', spec['context'])
        self.assertEqual(len(self.case()['items']), 10, 'the case file keeps every item')

    def test_a_return_closes_only_with_a_reference_and_a_pickup(self):
        self.cli(*ADD)
        self.assertIn('reference the app shows', self.cli('close', '--id', CID, '--reference', 'pending', '--pickup', 'x')[2])
        for ref in ('null', 'N/A', '...', 'later', 'x'):
            self.assertIn('reference the app shows', self.cli('close', '--id', CID, '--reference', ref,
                                                              '--pickup', 'Tue 27 Oct 9-1')[2], ref)
        for slot in ('pending', 'soon', 'tomorrow', 'TBD', 'morning', '2026-10-27 TBD', '2026-10-27',
                     'Tue 27 Oct', '27 Oct, time pending', '27 Oct 9-1?', 'Oct 27 25-30'):
            self.assertIn('booked date and window', self.cli('close', '--id', CID, '--reference', 'RT123',
                                                             '--pickup', slot)[2], slot)
        for slot in ('2026-99-99 09:00-13:00', '31 Feb 9-1', '30/02/2026 09:00-13:00', '2026-02-30 morning'):
            self.assertIn('does not exist', self.cli('close', '--id', CID, '--reference', 'RT123',
                                                     '--pickup', slot)[2], slot)
        self.assertIn('pickup slot', self.cli('close', '--id', CID, '--reference', 'RT123')[2])
        self.assertEqual(self.case()['status'], 'open')
        code, out, _ = self.cli('close', '--id', CID, '--reference', 'RT123', '--pickup', 'Tue 27 Oct 9-1')
        self.assertEqual((code, json.loads(out)['status']), (0, 'closed'))
        self.assertEqual(self.calls[-1], ['robob-watch', 'remove', CID])
        for slot in ('2026-10-27 09:00-13:00', '27th October, morning', 'Oct 27 9am-1pm',
                     '27/10/2026 09:00-13:00', '2026-10-27T09:00-13:00', 'Tue 27 Oct 9 to 1',
                     'Tuesday 27 October 09:00 – 13:00'):
            self.assertEqual(a.pickup_slot(slot), slot)
        self.assertEqual(self.case()['closed']['pickup'], 'Tue 27 Oct 9-1')
        self.assertIn('add it again to reopen', self.cli('update', '--id', CID, '--note', 'x')[2])

    def test_drop_and_reopen(self):
        self.cli(*ADD)
        self.assertEqual(self.cli('drop', '--id', CID, '--reason', 'Moni is keeping it')[0], 0)
        self.assertEqual(self.case()['status'], 'dropped')
        self.assertEqual(self.cli(*ADD)[0], 0)
        self.assertEqual([h['event'] for h in self.case()['history']], ['opened', 'dropped', 'reopened'])

    def test_list_shows_open_cases_and_missing_watchers(self):
        self.cli(*ADD)
        out = self.cli('list')[1]
        self.assertIn(CID, out)
        self.assertIn('next try Sat 24 Oct 09:00, deadline Fri 6 Nov', out)
        (self.watchers / CID / 'watcher.json').unlink()
        self.assertIn('WATCHER MISSING', self.cli('list')[1])
        self.cli('drop', '--id', CID, '--reason', 'x')
        self.assertEqual(self.cli('list')[1].strip(), 'No open aftercare.')
        self.assertIn('dropped: x', self.cli('list', '--all')[1])

    def test_check_is_an_outbox_that_repeats_daily(self):
        self.cli(*ADD)
        wdir = self.tmp / 'w'
        wdir.mkdir()
        due = a.epoch('2026-10-24T09:00:00+04:00')

        def tick(run, now, acked=True):
            out = a.check(CID, {'WATCH_DIR': str(wdir), 'WATCH_RUN': run}, now)
            if acked:
                (wdir / '.run-ok').write_text(run)
            return out
        self.assertEqual(tick('r0', due - 60), '')
        first = tick('prime-1', due, acked=False)
        self.assertIn("Aftercare due: Moni's noon return for order NAEIA0072787151", first)
        self.assertIn('Blocked last time: pickup dates only ran to 25 Oct', first)
        self.assertIn('Must meet: pickup on or after 27 Oct', first)
        self.assertIn('(13 days left)', first)
        self.assertEqual(tick('r1', due + 900), first, 'an unacked wake is printed again')
        self.assertEqual(tick('r2', due + 1800), '')
        again = tick('r3', due + 900 + a.REPEAT_S)
        self.assertIn('Still open; first due Sat 24 Oct 09:00.', again)
        self.assertEqual(tick('r4', due + 1800 + a.REPEAT_S), '')
        self.cli('update', '--id', CID, '--next-at', '2026-10-26T09:00:00+04:00', '--blocker', 'b')
        self.assertEqual(tick('r5', due + 2 * 3600 + a.REPEAT_S), '')
        later = tick('r6', a.epoch('2026-10-26T09:00:00+04:00'))
        self.assertIn('Blocked last time: b', later)
        self.assertNotIn('Still open', later)
        self.cli('close', '--id', CID, '--reference', 'RT1', '--pickup', 'Tue 27 Oct 9-1')
        self.assertEqual(tick('r7', due + 30 * 86400), '')
        self.assertEqual(a.check(CID, {}, due), '')
        self.assertEqual(a.check('aftercare-missing', {}, due), '')

    def test_order_watch_routes_aftercare(self):
        with mock.patch.object(a, 'main', return_value=0) as m:
            self.assertEqual(t.main(['aftercare', 'list']), 0)
        m.assert_called_once_with(['list'], session=t.SESSION)

    def test_a_failed_watcher_registration_keeps_the_case_and_fails(self):
        with mock.patch.object(a, 'run', side_effect=RuntimeError('robob-watch add failed: boom')):
            code, _, err = self.cli(*ADD)
        self.assertEqual(code, 1)
        self.assertIn('boom', err)
        self.assertEqual(self.case()['status'], 'open')
        self.assertNotIn('armed', self.case())
        self.assertIn('WATCHER MISSING', self.cli('list')[1])
        self.cli('update', '--id', CID, '--note', 'retry')
        self.assertEqual((self.case()['session'], self.case()['armed']), (SESSION, 1))
        self.assertNotIn('WATCHER', self.cli('list')[1])

    def test_check_and_cli_writes_never_share_a_temp_file(self):
        path = self.tmp / 'race' / 'aftercare-state.json'
        errors = []

        def writer(n):
            try:
                for i in range(300):
                    a.write(path, {'writer': n, 'i': i})
            except Exception as e:  # noqa: BLE001 - any failure is the bug
                errors.append(e)
        threads = [threading.Thread(target=writer, args=(n,)) for n in range(4)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        self.assertEqual(errors, [])
        self.assertEqual(sorted(p.name for p in path.parent.iterdir()), ['aftercare-state.json'])


def oct_mode(path):
    return path.stat().st_mode & 0o777


if __name__ == '__main__':
    unittest.main()

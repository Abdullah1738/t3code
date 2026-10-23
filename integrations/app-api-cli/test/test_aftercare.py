import io
import json
import sys
import tempfile
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

        def run(args, timeout=30):
            self.calls.append(args)
            if args[1] == 'add':
                d = self.watchers / args[args.index('--id') + 1]
                d.mkdir(parents=True)
                (d / 'watcher.json').write_text('{}')
                (d / 'state.json').write_text('{"status": "active"}')
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

    def test_add_saves_the_case_and_registers_one_wake_watcher(self):
        code, out, _ = self.cli(*ADD, '--request', 'Moni: ok it and the return too')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {'case': CID, 'status': 'open',
                                           'next_at': '2026-10-24T09:00:00+04:00', 'watcher': True})
        case = self.case()
        self.assertEqual((case['status'], case['for'], case['session']), ('open', 'moni', SESSION))
        self.assertEqual(case['deadline'], '2026-11-06T23:59:00+04:00')
        self.assertEqual(case['history'][0]['event'], 'opened')
        [add] = self.calls
        flag = lambda name: add[add.index(name) + 1]
        self.assertEqual(add[:2], ['robob-watch', 'add'])
        self.assertEqual((flag('--id'), flag('--mode'), flag('--max-fires'), flag('--session')),
                         (CID, 'wake', '0', SESSION))
        self.assertTrue(flag('--check').endswith(f'aftercare.py check --id {CID}'))
        self.assertEqual(a.epoch(flag('--expires')), a.epoch('2026-11-09T23:59:00+04:00'))
        context = flag('--context')
        for phrase in ('Never place, cancel or change an order', 'close the case with that reference',
                       'Banyantree Flat 2104', 'pickup on or after 27 Oct', 'refund to card 5542',
                       f'--key {CID}-closed', 'Never via imsg', 'Never say it is booked or refunded'):
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
        self.assertEqual(len(self.calls), 1)
        (self.watchers / CID / 'state.json').write_text('{"status": "expired"}')
        self.cli('update', '--id', CID, '--note', 'checked again')
        self.assertEqual(self.calls[-1][:3], ['robob-watch', 'resume', CID])
        case = self.case()
        self.assertEqual((case['blocker'], case['next_at']), ('still only to 26 Oct', '2026-10-25T09:00:00+04:00'))
        self.assertEqual([h['event'] for h in case['history']], ['opened', 'updated', 'updated'])
        self.assertIn('needs --blocker', self.cli('update', '--id', CID)[2])

    def test_a_return_closes_only_with_a_reference_and_a_pickup(self):
        self.cli(*ADD)
        self.assertIn('reference the app shows', self.cli('close', '--id', CID, '--reference', 'pending', '--pickup', 'x')[2])
        self.assertIn('pickup slot', self.cli('close', '--id', CID, '--reference', 'RT123')[2])
        self.assertEqual(self.case()['status'], 'open')
        code, out, _ = self.cli('close', '--id', CID, '--reference', 'RT123', '--pickup', 'Tue 27 Oct 9-1')
        self.assertEqual((code, json.loads(out)['status']), (0, 'closed'))
        self.assertEqual(self.calls[-1], ['robob-watch', 'remove', CID])
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
        self.assertIn('NO WATCHER', self.cli('list')[1])
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
        self.cli('close', '--id', CID, '--reference', 'RT1', '--pickup', 'Tue 27 Oct')
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
        self.assertNotIn('session', self.case())
        self.assertIn('NO WATCHER', self.cli('list')[1])
        self.cli('update', '--id', CID, '--note', 'retry')
        self.assertEqual(self.case()['session'], SESSION)


def oct_mode(path):
    return path.stat().st_mode & 0o777


if __name__ == '__main__':
    unittest.main()

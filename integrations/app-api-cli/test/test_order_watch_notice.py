"""Moni placement texts from order-watch add, and lane pass-through.

The bridge send and robob-watch are always mocked; nothing here can message anyone.
"""
import contextlib
import io
import json
import sqlite3
import subprocess
import tempfile
import unittest
import os as _os, tempfile as _tempfile
# The live card-status record must never decide these tests.
_os.environ['CARD_STATUS_FILE']=_os.path.join(_tempfile.mkdtemp(prefix='card-status-test-'),'card-status.json')
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import order_tracker as t
import order_watch_receipt as receipt


def sent_text(args):
    (text,) = [a[len('--text='):] for a in args if a.startswith('--text=')]
    return text


class AddNoticeTests(unittest.TestCase):
    def setUp(self):
        # Retain coverage for pre-card registrations and their legacy text retry.
        patcher = mock.patch.object(t, 'card_enrollment', return_value=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.sends = []
        self.send_code = 0
        self.send_error = None
        self.send_stdout = None
        self.robob_calls = []
        self.route = 'ardud-control:thread:0b46eb22-1111-2222-3333-444455556666'
        self.bridge_db = self.root / 'bridge.sqlite'
        con = sqlite3.connect(self.bridge_db)
        con.execute('create table kv (key text primary key, value text not null)')
        con.execute("insert into kv values ('route', ?)", (json.dumps({'id': self.route}),))
        con.commit()
        con.close()
        patcher = mock.patch.dict(_os.environ, {'SPECTRUM_BRIDGE_DB': str(self.bridge_db)})
        patcher.start()
        self.addCleanup(patcher.stop)
        for target, value in (('ROOT', self.root / 'state'), ('WATCHERS', self.root / 'watchers')):
            patcher = mock.patch.object(t, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for target, kwargs in (('run', {'side_effect': self.fake_run}),
                               ('subprocess.run', {'side_effect': self.fake_subprocess}),
                               ('store.reconcile', {'return_value': {}})):
            patcher = mock.patch.object(t, target, **kwargs) if '.' not in target else \
                mock.patch('order_tracker.' + target, **kwargs)
            patcher.start()
            self.addCleanup(patcher.stop)

    def fake_run(self, args, timeout=12):
        self.robob_calls.append(args)
        if args[:2] == ['robob-watch', 'add']:
            wid = args[args.index('--id') + 1]
            folder = self.root / 'watchers' / wid
            folder.mkdir(parents=True)
            (folder / 'watcher.json').write_text(json.dumps(
                {'id': wid, 'context': args[args.index('--context') + 1]}))
            (folder / 'order-tracker-state.json').write_text(json.dumps(
                {'last_result': {'status': 'preparing', 'eta': None, 'eta_text': 'Arrives in 25-35 mins'}}))
        return 'ok\n'

    def fake_subprocess(self, args, **kwargs):
        self.assertEqual(args[:5], [t.BUN, t.BRIDGE_CLI, 'send', '--to', 'moni'], 'only the bridge send may be spawned here')
        self.assertFalse(any(k.startswith('BUN_INSPECT') for k in kwargs['env']))
        self.sends.append(args)
        if self.send_error:
            raise self.send_error
        key = args[args.index('--key') + 1]
        out = self.send_stdout if self.send_stdout is not None else json.dumps(
            {'id': 'send:' + 'a' * 64, 'created': key not in [a[a.index('--key') + 1] for a in self.sends[:-1]]})
        return subprocess.CompletedProcess(args, self.send_code, out if self.send_code == 0 else '', '')

    def notice(self, order):
        return t.read(self.root / 'state' / 'orders' / f'order-talabat-{order}.json')['placed_notice']

    def add(self, *extra, order='3999000111', who='moni', label='Latea: 2x Brown Sugar Boba With Milk'):
        argv = ['add', '--app', 'talabat', '--order', order, '--for', who, '--label', label, *extra]
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = t.main(argv)
        lines = [x for x in out.getvalue().splitlines() if x.startswith('{"tracker_id"')]
        return code, json.loads(lines[-1])

    def test_moni_add_sends_once_to_her_robob_thread_and_is_idempotent(self):
        code, row = self.add()
        self.assertEqual(code, 0)
        self.assertEqual(row, {'tracker_id': 'order-talabat-3999000111', 'watcher_registered': True,
                               'moni_notified': 'sent', 'delivery_card': None})
        self.assertEqual(len(self.sends), 1)
        args = self.sends[0]
        self.assertNotIn('imsg', args)
        self.assertEqual(args[args.index('--session') + 1], self.route)
        self.assertEqual(args[args.index('--key') + 1], 'order-placed:order-talabat-3999000111')
        notice = self.notice('3999000111')
        self.assertEqual((notice['status'], notice['channel'], notice['bridge_id'], notice['created']),
                         ('sent', 'bridge', 'send:' + 'a' * 64, True))
        text = sent_text(args)
        self.assertEqual(text, 'Ordered: 2x Brown Sugar Boba With Milk from Latea. ETA in 25-35 mins.')
        self.assertFalse(text.lower().startswith('robob'))
        for word in ('watcher', 'tracker', 'order-watch', 'robob'):
            self.assertNotIn(word, text.lower())
        # A re-add (or a second lane call) never sends again.
        code, row = self.add()
        self.assertEqual((code, row['moni_notified']), (0, 'skipped'))
        self.assertEqual(len(self.sends), 1)

    def test_moni_watcher_context_names_the_bridge_not_imsg(self):
        self.add(order='3999000223')
        add = next(a for a in self.robob_calls if a[:2] == ['robob-watch', 'add'])
        context = add[add.index('--context') + 1]
        self.assertIn('spectrum-bridge/src/cli.ts send --to moni', context)
        self.assertIn('--key order-talabat-3999000223-<event>', context)
        self.assertNotIn('imsg send', context)
        self.assertNotIn('chat-id', context)
        self.assertLessEqual(len(context), 6000)

    def test_owner_add_never_texts_and_context_drops_arrival_question(self):
        code, row = self.add(who='owner', order='3999000222')
        self.assertEqual((code, row['moni_notified'], row['watcher_registered']), (0, 'skipped', True))
        self.assertEqual(self.sends, [])
        add = next(a for a in self.robob_calls if a[:2] == ['robob-watch', 'add'])
        context = add[add.index('--context') + 1]
        self.assertNotIn('actually arrive', context)
        self.assertNotIn('--asked', context)

    def test_custom_and_skipped_text(self):
        code, row = self.add('--placed-text', 'Got you the boba, about 30 min', order='3999000333')
        self.assertEqual((code, row['moni_notified']), (0, 'sent'))
        self.assertEqual(sent_text(self.sends[0]), 'Got you the boba, about 30 min')
        code, row = self.add('--no-placed-text', order='3999000444')
        self.assertEqual((code, row['moni_notified']), (0, 'skipped'))
        self.assertEqual(len(self.sends), 1)
        # Skipped stays skipped on re-add.
        self.assertEqual(self.add(order='3999000444')[1]['moni_notified'], 'skipped')
        self.assertEqual(len(self.sends), 1)

    def test_custom_text_cannot_start_with_robob(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            self.add('--placed-text', 'Robob: ordered your boba', order='3999000555')
        self.assertEqual(self.sends, [])

    def test_dry_run_prints_without_registering_writing_or_sending(self):
        code, row = self.add('--dry-run-text', order='3999000666')
        self.assertEqual(code, 0)
        self.assertEqual(row['moni_notified'], 'dry-run')
        self.assertFalse(row['watcher_registered'])
        self.assertTrue(row['text'].startswith('Ordered: 2x Brown Sugar Boba With Milk from Latea.'))
        self.assertEqual((self.sends, self.robob_calls), ([], []))
        self.assertFalse((self.root / 'state' / 'orders' / 'order-talabat-3999000666.json').exists())

    def test_total_flag_is_stored_and_sent_in_placed_text(self):
        code, row = self.add('--total', 'AED 47.25', order='3999000110')
        self.assertEqual((code, row['moni_notified']), (0, 'sent'))
        text = sent_text(self.sends[-1])
        self.assertEqual(text, 'Ordered: 2x Brown Sugar Boba With Milk from Latea, AED 47.25. ETA in 25-35 mins.')
        stored = t.read(self.root / 'state' / 'orders' / 'order-talabat-3999000110.json')
        self.assertEqual(stored['total'], 'AED 47.25')

    def test_failed_send_is_retried_only_with_the_same_key(self):
        self.send_code = 1
        code, row = self.add(order='3999000777')
        self.assertEqual((code, row['moni_notified']), (t.NOTICE_FAILED_EXIT, 'failed:bridge_exit_1'))
        self.assertTrue(row['watcher_registered'])
        self.assertEqual(self.notice('3999000777')['status'], 'ambiguous')
        first_text = sent_text(self.sends[0])
        # The bridge never sends one key twice, so the retry reuses the key and the text.
        self.send_code = 0
        code, row = self.add('--placed-text', 'something else', order='3999000777')
        self.assertEqual((code, row['moni_notified']), (0, 'sent'))
        self.assertEqual(len(self.sends), 2)
        keys = [a[a.index('--key') + 1] for a in self.sends]
        self.assertEqual(keys, ['order-placed:order-talabat-3999000777'] * 2)
        self.assertEqual(sent_text(self.sends[1]), first_text)
        self.assertEqual(self.notice('3999000777')['created'], False)
        # Sent stays sent.
        self.assertEqual(self.add(order='3999000777')[1]['moni_notified'], 'skipped')
        self.assertEqual(len(self.sends), 2)

    def test_imsg_era_unclear_send_is_never_resent(self):
        path = self.root / 'state' / 'orders' / 'order-talabat-3999000778.json'
        self.add('--hold-placed-text', order='3999000778')
        cfg = t.read(path)
        cfg['placed_notice'] = {'status': 'ambiguous', 'at': t.stamp(), 'text': 'x'}
        t.write(path, cfg)
        code, row = self.add(order='3999000778')
        self.assertEqual((code, row['moni_notified']), (t.NOTICE_FAILED_EXIT, 'failed:ambiguous_check_imsg_history'))
        self.assertEqual(self.sends, [])
        # After checking chat history the caller closes it out.
        code, row = self.add('--no-placed-text', order='3999000778')
        self.assertEqual((code, row['moni_notified']), (0, 'skipped'))

    def test_timeout_missing_bun_and_bad_ack(self):
        self.send_error = subprocess.TimeoutExpired('bun', 20)
        code, row = self.add(order='3999000888')
        self.assertEqual((code, row['moni_notified']), (t.NOTICE_FAILED_EXIT, 'failed:bridge_timeout'))
        self.assertEqual(self.notice('3999000888')['status'], 'ambiguous')
        self.send_error = OSError('no bun')
        code, row = self.add(order='3999000999')
        self.assertEqual((code, row['moni_notified']), (t.NOTICE_FAILED_EXIT, 'failed:bridge_unavailable'))
        # A send that never started may be retried.
        self.send_error = None
        self.assertEqual(self.add(order='3999000999')[1]['moni_notified'], 'sent')
        self.send_stdout = 'not json'
        code, row = self.add(order='3999000989')
        self.assertEqual((code, row['moni_notified']), (t.NOTICE_FAILED_EXIT, 'failed:bridge_bad_ack'))
        self.assertEqual(self.notice('3999000989')['status'], 'ambiguous')

    def test_text_starting_with_a_dash_is_passed_as_one_argument(self):
        code, row = self.add('--placed-text=- your boba is on the way', order='3999000904')
        self.assertEqual((code, row['moni_notified']), (0, 'sent'))
        self.assertIn('--text=- your boba is on the way', self.sends[-1])

    def test_bridge_notice_with_another_key_or_a_crash_mid_send(self):
        path = self.root / 'state' / 'orders' / 'order-talabat-3999000905.json'
        self.add('--hold-placed-text', order='3999000905')
        cfg = t.read(path)
        # A crash after 'attempting' was saved: the re-add retries with the same key and text.
        cfg['placed_notice'] = {'status': 'attempting', 'at': t.stamp(), 'text': 'Ordered: boba from Latea.',
                                'channel': 'bridge', 'key': 'order-placed:order-talabat-3999000905'}
        t.write(path, cfg)
        self.assertEqual(self.add('--hold-placed-text', order='3999000905')[1]['moni_notified'], 'held:payment_unconfirmed')
        self.assertEqual(self.sends, [])
        self.assertEqual(self.add(order='3999000905')[1]['moni_notified'], 'sent')
        self.assertEqual(sent_text(self.sends[-1]), 'Ordered: boba from Latea.')
        # A bridge notice under any other key is never resent.
        cfg = t.read(path)
        cfg['placed_notice'] = {**cfg['placed_notice'], 'status': 'ambiguous', 'key': 'order-placed:other'}
        t.write(path, cfg)
        code, row = self.add(order='3999000905')
        self.assertEqual((code, row['moni_notified']), (t.NOTICE_FAILED_EXIT, 'failed:ambiguous_check_imsg_history'))
        self.assertEqual(len(self.sends), 1)

    def test_no_route_sends_nothing_and_stays_pending(self):
        for setup in ('missing', 'empty', 'bad'):
            with self.subTest(setup=setup):
                order = {'missing': '3999000901', 'empty': '3999000902', 'bad': '3999000903'}[setup]
                if setup == 'missing':
                    self.bridge_db.unlink()
                else:
                    con = sqlite3.connect(self.bridge_db)
                    con.execute('create table if not exists kv (key text primary key, value text not null)')
                    con.execute('delete from kv')
                    if setup == 'bad':
                        con.execute("insert into kv values ('route', ?)", (json.dumps({'id': 'bad id; rm'}),))
                    con.commit()
                    con.close()
                code, row = self.add(order=order)
                self.assertEqual((code, row['moni_notified']), (t.NOTICE_FAILED_EXIT, 'failed:bridge_no_route'))
                self.assertEqual(self.notice(order)['status'], 'pending')
        self.assertEqual(self.sends, [])

    def test_unpaid_hold_keeps_notice_pending_for_paid_readd(self):
        code, row = self.add('--hold-placed-text', order='3999002000')
        self.assertEqual((code, row['moni_notified']), (0, 'held:payment_unconfirmed'))
        self.assertEqual(self.sends, [])
        code, row = self.add(order='3999002000')
        self.assertEqual((code, row['moni_notified']), (0, 'sent'))
        self.assertEqual(len(self.sends), 1)

    def test_notice_state_is_reread_under_lock(self):
        # Another add finished the send while this one was registering.
        code, row = self.add('--hold-placed-text', order='3999003000')
        path = self.root / 'state' / 'orders' / 'order-talabat-3999003000.json'
        real_read = t.read

        def racing_read(p, default=None):
            data = real_read(p, default)
            if p == path:
                data = dict(data, placed_notice={'status': 'sent'})
            return data
        with mock.patch.object(t, 'read', side_effect=racing_read):
            code, row = self.add(order='3999003000')
        self.assertEqual(row['moni_notified'], 'skipped')
        self.assertEqual(self.sends, [])

    def test_slow_first_check_still_sends_and_registers(self):
        def slow_prime(args, timeout=12):
            self.fake_run(args, timeout)  # watcher.json is written before the prime check
            raise subprocess.TimeoutExpired('robob-watch', timeout)
        with mock.patch.object(t, 'run', side_effect=slow_prime):
            code, row = self.add(order='3999004000')
        self.assertEqual((code, row['watcher_registered'], row['moni_notified']), (0, True, 'sent'))
        self.assertEqual([a[:2] for a in self.robob_calls], [['robob-watch', 'add']])
        # No watcher at all is a registration failure, and nobody is texted.
        with mock.patch.object(t, 'run', side_effect=RuntimeError('robob-watch failed')), \
                self.assertRaises(RuntimeError):
            self.add(order='3999004001')
        self.assertEqual(len(self.sends), 1)

    def test_existing_owner_registration_reports_moni_mismatch(self):
        self.add(who='owner', order='3999005000')
        code, row = self.add(order='3999005000')
        self.assertEqual((code, row['moni_notified']), (t.NOTICE_FAILED_EXIT, 'failed:registered_for_owner'))
        self.assertEqual(self.sends, [])

    def test_orders_registered_before_notices_are_not_texted(self):
        path = self.root / 'state' / 'orders' / 'order-talabat-3999001000.json'
        t.write(path, {'app': 'talabat', 'order': '3999001000', 'for': 'moni', 'label': 'x',
                       'placed_at': t.stamp(), 'registered_at': t.stamp(), 'eta': None,
                       'watcher': 'order-talabat-3999001000', 'active': True})
        code, row = self.add(order='3999001000')
        self.assertEqual((code, row['moni_notified']), (0, 'skipped'))
        self.assertEqual(self.sends, [])


class PlacementTextTests(unittest.TestCase):
    NOW = t.epoch('2026-10-15T10:00:00+04:00')

    def text(self, app, label, eta=None, result=None, store=None):
        return t.placement_text({'app': app, 'label': label, 'eta': eta}, result, store, self.NOW)

    def test_real_labels(self):
        self.assertEqual(self.text('noon', "noon main: Swanson beta carotene + Nature Made gummies (2 shipments)",
                                   '2026-11-01T23:59:00+04:00'),
                         'Ordered: Swanson beta carotene + Nature Made gummies from noon. ETA by Sun 1 Nov.')
        self.assertEqual(self.text('careem', 'Careem Quik: Method glass, Kyma refill', '2026-10-15T10:40:00+04:00'),
                         'Ordered: Method glass, Kyma refill from Careem Quik. ETA around 10:40am.')
        self.assertEqual(self.text('amazon', 'Amazon.ae Zalcoon spin mop + bucket', '2026-10-15T23:59:00+04:00'),
                         'Ordered: Zalcoon spin mop + bucket from Amazon. ETA by tonight.')

    def test_total_comes_from_config_or_result(self):
        self.assertEqual(t.placement_text({'app': 'noon', 'label': 'protein bars', 'total': 'AED 12'}, None, None, self.NOW),
                         'Ordered: protein bars from noon, AED 12.')
        self.assertEqual(t.placement_text({'app': 'noon', 'label': 'protein bars'}, {'total': 'AED 9.5'}, None, self.NOW),
                         'Ordered: protein bars from noon, AED 9.5.')
        self.assertEqual(self.text('talabat', 'Talabat order'), 'Placed your Talabat order.')

    def test_generic_lane_labels_and_eta_fallbacks(self):
        self.assertEqual(self.text('noon', 'Noon Minutes order', result={'eta': '2026-10-15T10:25:00+04:00'}),
                         'Placed your noon order. ETA around 10:25am.')
        self.assertEqual(self.text('talabat', 'Talabat order', result={'eta_text': 'Arrives in 25-35 mins'}),
                         'Placed your Talabat order. ETA in 25-35 mins.')
        self.assertEqual(self.text('noon', 'minutes Grenade bar (CLI E2E test)', '2026-10-16T09:00:00+04:00'),
                         'Placed your noon order. ETA tomorrow around 9:00am.')
        self.assertEqual(self.text('talabat', 'Talabat order'), 'Placed your Talabat order.')
        self.assertEqual(self.text('noon', 'protein bars', store='noon Minutes'),
                         'Ordered: protein bars from noon Minutes.')
        # A passed ETA is not repeated as a promise.
        self.assertEqual(self.text('noon', 'Noon Main order', '2026-10-14T23:59:00+04:00'),
                         'Placed your noon order.')


class ReceiptParseTests(unittest.TestCase):
    def test_parse_receipt_and_exit_codes(self):
        out = 'noise\n{"watcher": "w", "current": {}}\n{"tracker_id": "w", "watcher_registered": true, "moni_notified": "sent"}\n'
        self.assertEqual(receipt.parse(out, 0, 'moni', 'w'),
                         (True, {'for': 'moni', 'tracker_id': 'w', 'watcher_registered': True,
                                 'moni_notified': 'sent', 'moni_notice_failed': False,
                                  'moni_notice_held': False, 'delivery_card': None}))
        ok, row = receipt.parse(out.replace('"sent"', '"failed:bridge_exit_1"').encode(), 3, 'moni', 'w')
        self.assertTrue(ok)
        self.assertTrue(row['moni_notice_failed'])
        # Exit 3 is only a notice failure for Moni; any other failure is registration failure.
        self.assertFalse(receipt.parse(out, 3, 'owner', 'w')[0])
        self.assertFalse(receipt.parse(out, 1, 'moni', 'w')[0])
        # Older order-watch without a receipt: Moni is flagged, owner is fine.
        self.assertEqual(receipt.parse('{"watcher": "w"}', 0, 'moni', 'w')[1]['moni_notified'], 'failed:receipt_missing')
        self.assertEqual(receipt.parse('', 0, 'owner', 'w')[1]['moni_notified'], 'skipped')
        with self.assertRaises(ValueError):
            receipt.command_args('someone')


class CommandArgsTotalTests(unittest.TestCase):
    def test_int_total_is_passed_as_aed_amount(self):
        self.assertEqual(receipt.command_args('moni', 4725),
                         ['--for', 'moni', '--total', 'AED 47.25'])
        self.assertEqual(receipt.command_args('owner', 900), ['--for', 'owner', '--total', 'AED 9.00'])

    def test_missing_zero_negative_or_bool_total_adds_nothing(self):
        for total in (None, 0, -5, True, False, 47.25, '4725'):
            with self.subTest(total=total):
                self.assertEqual(receipt.command_args('moni', total), ['--for', 'moni'])

    def test_invalid_recipient_still_raises(self):
        with self.assertRaises(ValueError):
            receipt.command_args('someone', 4725)


class LaneRegistrationTests(unittest.TestCase):
    """Each noon lane passes --for through and returns the receipt fields."""

    def lanes(self):
        import commerce_main_order as main
        import commerce_minutes as minutes
        import commerce_nownow_order as nownow
        import commerce_supermall_order as supermall
        return (('main', main, 'order', lambda f, r: f.register_tracker('lbl', recipient=r)),
                ('nownow', nownow, 'order', lambda f, r: f.register_tracker('lbl', recipient=r)),
                ('supermall', supermall, 'order', lambda f, r: f.register_tracker('lbl', recipient=r)),
                ('minutes', minutes, 'review', lambda f, r: f.register_tracker('lbl', recipient=r)))

    def test_lanes_forward_recipient_and_receipt(self):
        for name, module, attr, call in self.lanes():
            for recipient, notified, code in (('owner', 'skipped', 0), ('moni', 'sent', 0),
                                              ('moni', 'failed:bridge_exit_1', 3)):
                with self.subTest(lane=name, recipient=recipient, code=code), \
                        tempfile.TemporaryDirectory() as temp:
                    flow = object.__new__(getattr(module, {'main': 'MainOrderFlow', 'nownow': 'NowNowOrderFlow',
                                                           'supermall': 'SupermallOrderFlow',
                                                           'minutes': 'MinutesFlow'}[name]))
                    flow.flow_id = 'f'
                    if attr == 'order':
                        flow.order = 'NAEIA1'
                    else:
                        flow.review = {'order': 'NAEIA1', 'placed_at': '2026-10-15T10:00:00+04:00'}
                    wid = 'order-noon-naeia1'
                    root = Path(temp)
                    (root / 'orders').mkdir()
                    (root / 'watchers' / wid).mkdir(parents=True)
                    (root / 'orders' / f'{wid}.json').write_text(json.dumps({'order': 'NAEIA1', 'active': True}))
                    (root / 'watchers' / wid / 'watcher.json').write_text('{"ok": 1}')
                    out = json.dumps({'tracker_id': wid, 'watcher_registered': True, 'moni_notified': notified})
                    done = subprocess.CompletedProcess([], code, stdout=out.encode(), stderr=b'')
                    journal = getattr(module, 'journal', None) or getattr(module, 'j')
                    with mock.patch.object(module, 'WATCH_ORDERS', root / 'orders'), \
                            mock.patch.object(module, 'WATCH_WATCHERS', root / 'watchers'), \
                            mock.patch.object(module.subprocess, 'run', return_value=done) as run, \
                            mock.patch.object(journal, 'observe') as observe:
                        result = call(flow, recipient)
                    argv = run.call_args.args[0]
                    self.assertEqual(argv[argv.index('--for') + 1], recipient)
                    self.assertEqual(result['watcher'], wid)
                    self.assertEqual(result['moni_notified'], notified)
                    self.assertEqual(result['moni_notice_failed'], code == 3)
                    observe.assert_called_once()

    def test_registration_failure_still_fails_lane(self):
        import commerce_main_order as main
        flow = object.__new__(main.MainOrderFlow)
        flow.flow_id, flow.order = 'f', 'NAEIA1'
        done = subprocess.CompletedProcess([], 1, stdout=b'', stderr=b'')
        with mock.patch.object(main.subprocess, 'run', return_value=done), \
                mock.patch.object(main, 'WATCH_ORDERS', Path('/nonexistent')), \
                self.assertRaises(Exception) as caught:
            flow.register_tracker('lbl', recipient='moni')
        self.assertIn('TRACKER_REGISTRATION_UNCONFIRMED', str(caught.exception))


class CLIPassThroughTests(unittest.TestCase):
    def test_every_order_lane_accepts_for_and_defaults_to_owner(self):
        import commerce_cli as cli
        for prefix, target in ((['order', 'talabat', '--branch', '1', '--item', '2'], 'purchase_talabat'),
                               (['order', 'minutes', '--sku', 'S'], 'order_minutes'),
                               (['order', 'nownow', '--product-code', 'P', '--store-code', 'S'], 'order_nownow'),
                               (['order', 'main', '--sku-config', 'Z'], 'order_main'),
                               (['order', 'supermall', '--sku-config', 'Z'], 'order_supermall')):
            for extra, expected in (([], 'owner'), (['--for', 'moni', '--moni-go', 'yes order it'], 'moni')):
                with self.subTest(lane=prefix[1], extra=extra), \
                        mock.patch('moni_go.verify', return_value={'message_id': 1}), \
                        mock.patch.object(cli, target, return_value={'ok': True}) as lane, \
                        contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(cli.main([*prefix, *extra]), 0)
                self.assertEqual(lane.call_args.args[0].recipient, expected)

    def test_talabat_holds_moni_text_until_payment_success(self):
        import commerce_cli as cli
        for state, hold in (('PAYMENT_REPORTED_SUCCESS', False), ('PAYMENT_UNKNOWN', True),
                            ('CHALLENGE_REQUIRED', True)):
            flow = mock.Mock(flow_id='f')
            flow.purchase.return_value = {'state': state}
            with self.subTest(state=state), \
                    mock.patch.object(cli.journal, 'inspect', return_value={'order_id': '3999', 'app': 'talabat', 'vertical': 'shops'}), \
                    mock.patch.object(cli, 'register_tracking', return_value={'watcher': 'w'}) as register:
                args = SimpleNamespace(label='Latea: boba', recipient='moni', prepare_only=False, resume_flow=None)
                with mock.patch('commerce_talabat.TalabatFlow', return_value=flow), \
                        mock.patch.object(cli, 'input_items', return_value=[]), \
                        mock.patch('talabat_basket.parse_items', return_value=()), \
                        mock.patch.object(cli.talabat.shared, 'verticals_key', return_value='k'), \
                        mock.patch.object(cli.journal, 'complete'), \
                        contextlib.redirect_stdout(io.StringIO()):
                    args.vertical, args.branch, args.apk_pool = 'restaurants', 1, 'pool'
                    flow.prepare.return_value = {'payable_minor': 100}
                    flow.checkout.track.return_value = {'order': '3999', 'status': 'preparing',
                        'order_list_present': True, 'order_account_verified': True}
                    cli.purchase_talabat(args)
                self.assertEqual(register.call_args.kwargs['paid'], not hold)
                self.assertEqual(register.call_args.args[2], 'moni')

    def test_register_tracking_adds_hold_flag_only_when_unpaid(self):
        import commerce_cli as cli
        for paid in (True, False):
            with self.subTest(paid=paid), tempfile.TemporaryDirectory() as temp, \
                    mock.patch.object(cli.journal, 'inspect', return_value={'order_id': '3999', 'app': 'talabat', 'vertical': 'shops'}), \
                    mock.patch.object(cli.Path, 'home', return_value=Path(temp)), \
                    mock.patch.object(cli.subprocess, 'run', return_value=subprocess.CompletedProcess(
                        [], 0, stdout=b'{"moni_notified": "held:payment_unconfirmed"}', stderr=b'')) as run:
                name = 'order-talabat-3999'
                (Path(temp) / '.local/state/order-tracker/orders').mkdir(parents=True)
                (Path(temp) / '.local/share/robob-watch/watchers' / name).mkdir(parents=True)
                (Path(temp) / f'.local/state/order-tracker/orders/{name}.json').write_text(
                    json.dumps({'order': '3999', 'watcher': name, 'active': True}))
                (Path(temp) / f'.local/share/robob-watch/watchers/{name}/watcher.json').write_text('{"id": 1}')
                flow = mock.Mock(flow_id='f')
                result = cli.register_tracking(flow, 'lbl', 'moni', paid=paid)
                self.assertEqual('--hold-placed-text' in run.call_args.args[0], not paid)
                self.assertEqual(result['for'], 'moni')
                self.assertTrue(result['moni_notice_held'])
                self.assertFalse(result['moni_notice_failed'])

    def test_nownow_success_output_carries_receipt(self):
        import commerce_cli as cli
        flow = mock.Mock(flow_id='f', order='NNX', review={'payable_minor': 100})
        flow.prepare_only.return_value = {'flow_id': 'f', 'prepared_only': True, 'review': {'payable_minor': 100},
                                          'readback': {'ok': True}}
        flow.place.return_value = {'order': 'NNX'}
        flow.confirm_paid.return_value = {'paid': True}
        flow.poll_tracking.return_value = {'status': 'preparing', 'estimate': '2026-10-15T10:30:00+04:00'}
        flow.register_tracker.return_value = {'watcher': 'order-noon-nnx', 'registered': True, 'for': 'moni',
                                              'tracker_id': 'order-noon-nnx', 'watcher_registered': True,
                                              'moni_notified': 'sent', 'moni_notice_failed': False}
        with mock.patch('commerce_nownow_order.NowNowOrderFlow', return_value=flow), \
                mock.patch.object(cli, 'CommerceAuth'), mock.patch.object(cli.journal, 'complete'), \
                mock.patch('moni_go.verify', return_value={'message_id': 1}), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            code = cli.main(['order', 'nownow', '--product-code', 'P', '--store-code', 'S', '--for', 'moni',
                             '--moni-go', 'yes order it'])
        final = json.loads(out.getvalue().splitlines()[-1])
        self.assertEqual(code, 0)
        self.assertEqual(flow.register_tracker.call_args.kwargs['recipient'], 'moni')
        self.assertEqual((final['moni_notified'], final['tracker_id'], final['for']),
                         ('sent', 'order-noon-nnx', 'moni'))


if __name__ == '__main__':
    unittest.main()

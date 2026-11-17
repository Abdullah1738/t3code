"""Scheduled and quiet-hours polls share durable retry state; all sends are fake."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import order_tracker as t
import amazon_email_orders as amazon
from test_amazon_email_orders import FakeMailsearch, NOW, OID, confirmation


class PollBackoff(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.clock = 10000
        self.polls = []
        self.sends = []
        self.failing_source = True
        self.ack = True
        self.real_fetch = t.fetch
        for name in ('failing', 'healthy'):
            folder = self.root / name
            folder.mkdir()
            t.write(folder / 'watcher.json', {'interval_s': 60})
            t.write(folder / 'order-tracker-state.json', {'primed': True, 'status': 'placed'})
        patches = [mock.patch.object(t, 'WATCHERS', self.root),
                   mock.patch.object(t.time, 'time', side_effect=lambda: self.clock),
                   mock.patch.object(t, 'fetch', side_effect=self.fetch),
                   mock.patch.object(t, 'bank_charge_events', return_value=[]),
                   mock.patch.object(t.delivery_cards, 'safe_sync', return_value={}),
                   mock.patch.object(t, 'bridge_route', return_value='fixture-session'),
                   mock.patch.object(t.subprocess, 'run', side_effect=self.send),
                   mock.patch.dict(os.environ, TOOLLOG_ROOT=str(self.root / 'logs'),
                                   ROBOB_TOOL_LOG_DIR=str(self.root / 'logs'),
                                   WATCH_RUN='scheduled-fixture', WATCH_MAIN_CHECKED='0')]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def cfg(self, name='failing', **changes):
        return {'app': 'amazon', 'order': name, 'watcher': name, 'for': 'owner',
                'registered_at': t.stamp(10000), 'total': 'AED 49.00', **changes}

    def fetch(self, cfg, state, now):
        self.polls.append((cfg['order'], now))
        return {'status': 'placed', 'errors': ['amazon_email_unavailable']
                if cfg['order'] == 'failing' and self.failing_source else []}

    def send(self, args, **kwargs):
        self.sends.append(args)
        if not self.ack:
            raise subprocess.TimeoutExpired(args, 20)
        return subprocess.CompletedProcess(args, 0, json.dumps({'id': 'fixture-send', 'created': True}), '')

    def check(self, cfg=None, *, pending=False, main_checked=False):
        cfg = cfg or self.cfg()
        with mock.patch.dict(os.environ, WATCH_DIR=str(self.root / cfg['watcher']),
                             WATCH_MAIN_CHECKED='1' if main_checked else '0'), \
                contextlib.redirect_stdout(io.StringIO()):
            return t._check(cfg, pending_only=pending)

    def state(self, name='failing'):
        return t.read(self.root / name / 'order-tracker-state.json')

    def test_forced_failure_simulation_backoff_one_notice_and_healthy_tracker(self):
        for offset in range(0, 7201, 60):
            self.clock = 10000 + offset
            self.check()
            self.check(pending=True, main_checked=True)
            self.check(self.cfg('healthy'))
        failing = [at - 10000 for name, at in self.polls if name == 'failing']
        healthy = [at - 10000 for name, at in self.polls if name == 'healthy']
        self.assertEqual(failing, [0, 60, 120, 240, 480, 960, 1920, 3720, 5520])
        self.assertEqual(healthy, list(range(0, 7201, 60)))
        self.assertEqual(len(self.sends), 1)
        self.assertIn('tracking is unavailable', ' '.join(self.sends[0]))
        self.assertEqual(self.state()['consecutive_failures'], 9)
        rows = [json.loads(line) for file in (self.root / 'logs/orders').glob('*.ndjson')
                for line in file.read_text().splitlines()]
        polls = [row for row in rows if row['name'] == 'track.poll' and row['props'].get('polled')]
        self.assertEqual(len(polls), 130)
        self.assertEqual(max(row['props']['poll_interval_s'] for row in polls), 1800)

    def test_success_resets_schedule_but_never_rearms_notice(self):
        for at in (10000, 10060, 10120):
            self.clock = at
            self.check()
            self.check(pending=True, main_checked=True)
        self.failing_source = False
        self.clock = 10240
        self.check()
        self.assertEqual(self.state()['consecutive_failures'], 0)
        self.assertNotIn('next_poll_at', self.state())
        self.failing_source = True
        for at in (10300, 10360, 10420, 10540):
            self.clock = at
            self.check()
            self.check(pending=True, main_checked=True)
        self.assertEqual(len(self.polls), 8)
        self.assertEqual(len(self.sends), 1)

    def test_quiet_pending_reads_share_backoff_with_main_check(self):
        cfg = self.cfg(total='AED 600.00')
        for at in (10000, 10060, 10120):
            self.clock = at
            self.check(cfg, pending=True)
        self.clock = 10180
        self.check(cfg)
        self.check(cfg, pending=True)
        self.assertEqual(len(self.polls), 3)
        self.assertEqual(len(self.sends), 1)  # Existing expensive-order alert.
        self.assertEqual(self.state()['status'], 'placed')

    def test_notice_retries_identical_key_after_ambiguous_send_during_backoff(self):
        for at in (10000, 10060, 10120):
            self.clock = at
            self.check()
        self.ack = False
        self.check(pending=True, main_checked=True)
        self.ack = True
        self.clock = 10180
        self.check(pending=True, main_checked=True)
        self.check(pending=True, main_checked=True)
        self.assertEqual(len(self.sends), 2)
        self.assertEqual(self.sends[0], self.sends[1])
        self.assertEqual(len(self.polls), 3)

    def test_requester_route_is_retained_even_if_config_changes(self):
        cfg = self.cfg(chat='moni', **{'for': 'moni'})
        for at in (10000, 10060, 10120):
            self.clock = at
            self.check(cfg)
        self.check(self.cfg(), pending=True, main_checked=True)
        self.assertEqual(self.sends[0][:5], [t.BUN, t.BRIDGE_CLI, 'send', '--to', 'moni'])
        self.assertIn('--session', self.sends[0])

    def test_raised_poll_failure_backs_off_and_queues_notice(self):
        with mock.patch.object(t, 'fetch', side_effect=TimeoutError('private-value')) as fetch:
            for at in (10000, 10060, 10120):
                self.clock = at
                with self.assertRaises(TimeoutError):
                    self.check()
            self.clock = 10180
            self.check()
            self.check(pending=True, main_checked=True)
        self.assertEqual(fetch.call_count, 3)
        self.assertEqual(len(self.sends), 1)
        self.assertNotIn('private-value', json.dumps(self.state()))

    def test_non_amazon_failures_keep_their_existing_cadence(self):
        for at in range(10000, 10601, 60):
            self.clock = at
            self.check(self.cfg(app='noon'))
        self.assertEqual(len(self.polls), 11)
        self.assertNotIn('next_poll_at', self.state())
        self.assertEqual(self.sends, [])

    def test_base_cadences_and_legacy_streaks_double_up_to_cap(self):
        for base, expected in [(60, [60, 60, 120, 240, 480, 960, 1800, 1800]),
                               (300, [300, 300, 600, 1200, 1800, 1800, 1800, 1800]),
                               (900, [900, 900, 1800, 1800, 1800, 1800, 1800, 1800]),
                               (3600, [3600] * 8)]:
            with self.subTest(base=base):
                state = {}
                for count, delay in enumerate(expected, 1):
                    t.record_poll(state, False, self.clock, base, self.cfg())
                    self.assertEqual(state['consecutive_failures'], count)
                    if count >= 3:
                        self.assertEqual(state['next_poll_at'], self.clock + delay)
                    else:
                        self.assertNotIn('next_poll_at', state)
                t.record_poll(state, True, self.clock, base, self.cfg())
                self.assertEqual(state['consecutive_failures'], 0)
                self.assertNotIn('next_poll_at', state)
        t.write(self.root / 'failing/order-tracker-state.json',
                {'primed': True, 'status': 'placed', 'consecutive_failures': 774})
        self.check()
        self.assertEqual(self.state()['next_poll_at'], self.clock + 1800)
        self.clock += 60
        self.check()
        self.assertEqual(len(self.polls), 1)

    def test_backoff_starts_after_poll_completion_and_survives_process_state_reload(self):
        t.write(self.root / 'failing/order-tracker-state.json',
                {'primed': True, 'status': 'placed', 'consecutive_failures': 2})
        original = self.fetch
        def slow_fetch(*args):
            self.clock += 37
            return original(*args)
        with mock.patch.object(t, 'fetch', side_effect=slow_fetch):
            self.check()
        self.assertEqual(self.state()['next_poll_at'], 10157)
        self.clock = 10156
        self.check()
        self.assertEqual(len(self.polls), 1)
        self.clock = 10157
        self.check()
        self.assertEqual(len(self.polls), 2)

    def test_prime_retains_notice_and_scratch_check_cannot_send(self):
        t.write(self.root / 'failing/order-tracker-state.json',
                {'primed': True, 'status': 'placed', 'consecutive_failures': 2})
        with mock.patch.dict(os.environ, WATCH_RUN='prime-fixture'):
            self.check()
            self.check(pending=True, main_checked=True)
        self.assertEqual(self.sends, [])
        with mock.patch.object(t, 'WATCHERS', self.root / 'other'):
            self.check(pending=True, main_checked=True)
        self.assertEqual(self.sends, [])
        self.check(pending=True, main_checked=True)
        self.assertEqual(len(self.sends), 1)

    def test_large_order_keeps_immediate_owner_alert_and_one_requester_notice(self):
        cfg = self.cfg(total='AED 600.00', chat='moni', **{'for': 'moni'})
        for at, count in [(10000, 1), (10060, 1), (10120, 2)]:
            self.clock = at
            self.check(cfg)
            self.check(cfg, pending=True, main_checked=True)
            self.assertEqual(len(self.sends), count)
        self.assertEqual(self.sends[0][1], t.PROBLEM_CLI)
        self.assertEqual(self.sends[1][:5], [t.BUN, t.BRIDGE_CLI, 'send', '--to', 'moni'])

    def test_terminal_tracker_flushes_retained_notice_without_polling(self):
        t.write(self.root / 'failing/order-tracker-state.json', {
            'primed': True, 'status': 'delivered', 'last_result': {'status': 'delivered', 'whole_order_complete': True},
            'problem_notices': {'retained-key': {'status': 'pending', 'chat': 'owner', 'text': 'fixture notice'}}})
        self.check(pending=True, main_checked=True)
        self.assertEqual(self.polls, [])
        self.assertEqual(len(self.sends), 1)

    def test_card_interruption_cannot_erase_retry_deadline_or_notice(self):
        t.write(self.root / 'failing/order-tracker-state.json',
                {'primed': True, 'status': 'placed', 'consecutive_failures': 2})
        def interrupted_render(cfg, result, **kwargs):
            raise KeyboardInterrupt
        with mock.patch.object(t.delivery_cards, 'safe_sync', side_effect=interrupted_render):
            with self.assertRaises(KeyboardInterrupt):
                self.check()
        self.assertEqual(self.state()['next_poll_at'], 10120)
        self.assertEqual(len(self.state()['problem_notices']), 1)
        self.clock = 10060
        self.check()
        self.check(pending=True, main_checked=True)
        self.assertEqual(len(self.polls), 1)
        self.assertEqual(len(self.sends), 1)

    @contextlib.contextmanager
    def real_amazon(self, *, warnings=(), failures=None, exception=None, pushes=()):
        fake = FakeMailsearch(messages={1: confirmation()}, failures=failures)
        real_track = amazon.track
        cfg = self.cfg(order=OID, placed_at=t.stamp(NOW.timestamp() - 86400),
                       registered_at=t.stamp(self.clock))
        def track(order, **options):
            if exception:
                raise exception
            return real_track(order, **options, now=NOW, runner=fake)
        with mock.patch.object(t, 'fetch', wraps=self.real_fetch) as fetch, \
                mock.patch.object(amazon, 'track', side_effect=track) as reads, \
                mock.patch.object(t.store, 'evidence', return_value=(list(pushes), list(warnings))), \
                mock.patch.object(t, 'single_allowed', return_value=False):
            yield cfg, fetch, reads

    def test_real_fetch_success_and_cached_success_ignore_optional_notification_errors(self):
        warning_forms = [[], ['notification_collector_stale'], ['notifications_priority_hold_stale'],
                         ['notifications_OperationalError'], ['notifications_TimeoutExpired'],
                         ['notification_collector_stale', 'notifications_RuntimeError']]
        for warnings in warning_forms:
            with self.subTest(warnings=warnings):
                t.write(self.root / 'failing/order-tracker-state.json', {'primed': True, 'status': 'placed'})
                self.sends.clear()
                self.clock = 10000
                with self.real_amazon(warnings=warnings) as (cfg, fetch, reads):
                    for offset in range(0, 1201, 60):
                        self.clock = 10000 + offset
                        self.check(cfg)
                        self.check(cfg, pending=True, main_checked=True)
                        state = self.state()
                        self.assertEqual(state['consecutive_failures'], 0)
                        self.assertEqual(state['last_success_at'], t.stamp(self.clock))
                        self.assertNotIn('next_poll_at', state)
                        self.assertEqual(state.get('problem_notices', {}), {})
                        self.assertEqual(state['last_result']['errors'], warnings)
                    self.assertEqual(fetch.call_count, 21)
                    self.assertEqual(reads.call_count, 5)
                self.assertEqual(self.sends, [])

    def test_real_fetch_success_resets_previous_failures_despite_notification_errors(self):
        for pending in (False, True):
            with self.subTest(pending=pending):
                t.write(self.root / 'failing/order-tracker-state.json', {
                    'primed': True, 'status': 'placed', 'consecutive_failures': 7, 'next_poll_at': self.clock})
                # Pending-only source reads are available for expensive orders.
                with self.real_amazon(warnings=['notification_collector_stale']) as (cfg, _, reads):
                    cfg['total'] = 'AED 600.00' if pending else 'AED 49.00'
                    self.check(cfg, pending=pending)
                    self.assertEqual(reads.call_count, 1)
                self.assertEqual(self.state()['consecutive_failures'], 0)
                self.assertNotIn('next_poll_at', self.state())
                self.assertFalse(any(key.startswith('order-unavailable:')
                                     for key in self.state().get('problem_notices', {})))

    def test_real_fetch_amazon_failures_still_back_off_with_optional_notifications(self):
        forms = [({'account': 'timeout'}, (), None),
                 ({1: 'read failed'}, ('notification_collector_stale',), None),
                 (None, ('notifications_priority_hold_stale',), subprocess.TimeoutExpired('fixture', 35))]
        push = {'stage': 'delivered', 'observed_at': t.stamp(self.clock), 'confidence': 'exact_order'}
        for failures, warnings, exception in forms:
            with self.subTest(failures=failures, warnings=warnings, exception=type(exception).__name__):
                t.write(self.root / 'failing/order-tracker-state.json', {'primed': True, 'status': 'placed'})
                self.sends.clear()
                self.clock = 10000
                with self.real_amazon(warnings=warnings, failures=failures, exception=exception,
                                     pushes=[push]) as (cfg, fetch, _):
                    for offset in range(0, 7201, 60):
                        self.clock = 10000 + offset
                        self.check(cfg)
                        self.check(cfg, pending=True, main_checked=True)
                    self.assertEqual(fetch.call_count, 9)
                self.assertEqual(self.state()['consecutive_failures'], 9)
                self.assertEqual(self.state()['next_poll_at'], 17320)
                self.assertEqual(len(self.sends), 1)
                self.assertTrue(self.state()['last_result']['errors'])


if __name__ == '__main__':
    unittest.main()

"""Website mail raises scoped notices; only removal or expiry stops tracking."""
import io
import json
import os
from contextlib import redirect_stdout
from pathlib import Path
import subprocess
from unittest import TestCase, main, mock

from test import test_order_tracker_web as fixtures

tracker = fixtures.tracker


class WebNoticeModeTests(TestCase):
    def setUp(self):
        self.f = fixtures.WebTrackerTest()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)

    def prepare(self, state=None):
        cfg = self.f.cfg
        folder = tracker.WATCHERS / cfg['watcher']
        path = tracker.ROOT / 'orders' / (cfg['watcher'] + '.json')
        tracker.write(path, dict(cfg, active=True))
        tracker.write(folder / 'watcher.json', {})
        tracker.write(folder / 'order-tracker-state.json', state if state is not None else {'primed': True, 'status': 'ordered'})
        return cfg, folder, path

    def check(self, hits, body='Order #2606', *, state=None, elapsed=(0, 0, 301), pending_first=False):
        cfg, folder, path = self.prepare(state)
        output = io.StringIO()
        with self.f.mail(hits), mock.patch.object(tracker, 'run', return_value=body), \
                mock.patch.object(tracker, 'retire', side_effect=AssertionError('automatic retirement')), \
                mock.patch('native_orders.track', side_effect=AssertionError('native read')), \
                mock.patch.object(tracker.delivery_cards, 'safe_sync', return_value={'status': 'skipped'}), \
                mock.patch.dict(os.environ, {'WATCH_DIR': str(folder), 'WATCH_RUN': 'scheduled-fixture'}), \
                redirect_stdout(output):
            if pending_first:
                tracker._check(cfg, pending_only=True)
            for seconds in elapsed:
                with mock.patch.object(tracker.time, 'time', return_value=self.f.now + seconds):
                    tracker._check(cfg)
                self.assertTrue(tracker.read(path)['active'])
                saved = tracker.read(folder / 'order-tracker-state.json')
                self.assertNotIn(saved.get('status'), tracker.TERMINAL)
                self.assertNotIn('terminal_at', saved)
                self.assertFalse(saved['last_result']['whole_order_complete'])
        events = [event for line in output.getvalue().splitlines() for event in json.loads(line)['events']]
        self.assertFalse(any(e['kind'] == 'stage_change' and e['status'] in tracker.TERMINAL for e in events))
        return cfg, folder, path, events

    def test_delivered_and_cancelled_mail_notify_once_without_retirement(self):
        for stage in ('delivered', 'cancelled'):
            with self.subTest(stage=stage):
                _, _, _, events = self.check([self.f.hit(subject=f'Order #2606 {stage}')])
                self.assertEqual([e['kind'] for e in events], ['shipment_' + stage])
                self.assertEqual(events[0]['scope'], 'shipment')

    def test_first_successful_unprimed_check_announces_each_notice_once(self):
        for stage in ('delivered', 'cancelled'):
            with self.subTest(stage=stage):
                _, _, _, events = self.check([self.f.hit(subject=f'Order #2606 {stage}')], state={})
                self.assertEqual([e['kind'] for e in events], ['shipment_' + stage])

    def test_web_prime_never_reads_or_consumes_a_notice(self):
        for stage in ('delivered', 'cancelled'):
            with self.subTest(stage=stage):
                cfg, folder, path = self.prepare({})
                with mock.patch.object(tracker, 'fetch', side_effect=AssertionError('prime consumed mail')), \
                        mock.patch.dict(os.environ, {'WATCH_DIR': str(folder), 'WATCH_RUN': 'prime-fixture'}), \
                        redirect_stdout(io.StringIO()) as output:
                    tracker._check(cfg)
                self.assertEqual(output.getvalue(), '')
                saved = tracker.read(folder / 'order-tracker-state.json')
                self.assertEqual(saved, {})
                self.assertTrue(tracker.read(path)['active'])
                _, _, _, events = self.check([self.f.hit(subject=f'Order #2606 {stage}')], state=saved)
                self.assertEqual([e['kind'] for e in events], ['shipment_' + stage])

    def test_pending_checks_do_not_consume_arrival_or_cancellation_notices(self):
        self.f.cfg['total'] = 'AED 500'
        for stage in ('delivered', 'cancelled'):
            with self.subTest(stage=stage):
                _, _, _, events = self.check([self.f.hit(subject=f'Order #2606 {stage}')], pending_first=True)
                self.assertEqual([e['kind'] for e in events], ['shipment_' + stage])

    def test_older_completion_with_newer_doubt_or_package_notice_never_retires(self):
        signals = ['Pending items: 1', 'Backordered', 'Delivery status: partial delivery', '']
        for index, signal in enumerate(signals):
            with self.subTest(row=index):
                hits = [self.f.hit(subject='Order #2606 delivered in full', uid=1, date=tracker.stamp(self.f.now - 600)),
                        self.f.hit(subject='Your package has been delivered - Order #2606' if not signal else 'Order #2606 delivered', uid=2)]
                _, _, _, events = self.check(hits, 'Order #2606\n' + signal)
                self.assertEqual([e['kind'] for e in events], ['shipment_delivered', 'shipment_delivered'])

    def test_cached_terminal_flags_never_authorize_web_retirement(self):
        for version in (2, 3, 4, tracker.WEB_PROOF_VERSION):
            for stage in ('delivered', 'cancelled'):
                with self.subTest(version=version, stage=stage):
                    proof = {'stage': stage, 'scope': 'order', 'observed_at': tracker.stamp(self.f.now - 60),
                             'source': 'order_email', 'mail_key': 'icloud:Inbox:1'}
                    state = {'primed': True, 'status': stage, 'terminal_at': self.f.now,
                             'web_proof_version': version, 'mail_checked': self.f.now, 'mail_cache': [proof],
                             'last_result': {'status': stage, 'whole_order_complete': True, 'web_proof_version': version}}
                    _, _, _, events = self.check([self.f.hit(subject=f'Order #2606 {stage}')], state=state)
                    self.assertEqual([e['kind'] for e in events], ['shipment_' + stage])

    def test_terminal_predicate_and_retirement_entry_point_reject_web(self):
        cfg, folder, path = self.prepare()
        for stage in ('delivered', 'cancelled'):
            result = {'status': stage, 'whole_order_complete': True, 'web_proof_version': tracker.WEB_PROOF_VERSION}
            self.assertFalse(tracker.terminal_order(cfg, result))
            with mock.patch.object(tracker, 'retire', side_effect=AssertionError('automatic retirement')):
                tracker.retire_terminal(cfg, folder, path, {'status': stage, 'last_result': result})
            self.assertTrue(tracker.read(path)['active'])

    def test_arrival_and_cancellation_still_reach_one_48_hour_problem(self):
        for stage in ('delivered', 'cancelled'):
            for progress in ('ordered', 'shipped', 'out for delivery'):
                for eta, label in ((None, 'missing'), (self.f.now - 600, 'elapsed'), (self.f.now + 10 * 86400, 'open')):
                    with self.subTest(stage=stage, progress=progress, eta=label):
                        self.f.cfg['eta'] = tracker.stamp(eta) if eta else None
                        subject = 'Order #2606 confirmed' if progress == 'ordered' else f'Order #2606 {progress}'
                        hits = [self.f.hit(subject=subject, uid=2, date=tracker.stamp(self.f.now - 600)),
                                self.f.hit(subject=f'Order #2606 {stage}')]
                        _, _, _, events = self.check(hits, state={'primed': True, 'status': progress},
                                                     elapsed=(0, 47 * 3600, 49 * 3600, 72 * 3600))
                        self.assertEqual(sum(e['kind'] == 'shipment_' + stage for e in events), 1)
                        self.assertEqual(sum(e['kind'] == 'tracking_problem' for e in events), 1)

    def test_manual_remove_still_stops_web_tracking_after_a_notice(self):
        for stage in ('delivered', 'cancelled'):
            with self.subTest(stage=stage):
                cfg, _, path, _ = self.check([self.f.hit(subject=f'Order #2606 {stage}')])
                with mock.patch.object(tracker, 'run', return_value='{}'):
                    self.f.cli('remove', '--app', 'web', '--order', cfg['order'],
                               '--merchant-domain', cfg['merchant_domain'])
                self.assertFalse(tracker.read(path)['active'])

    def test_wrong_domain_stale_or_conflicting_mail_never_raises_a_notice(self):
        for stage in ('delivered', 'cancelled'):
            rows = [(self.f.hit(subject=f'Order #2606 {stage}', **{'from': 'orders@other.shop'}), 'Order #2606'),
                    (self.f.hit(subject=f'Order #2606 {stage}', date=tracker.stamp(self.f.now - 7200)), 'Order #2606'),
                    (self.f.hit(subject=f'Order #2606 {stage}'), 'Order #9999')]
            for index, (hit, body) in enumerate(rows):
                with self.subTest(stage=stage, row=index):
                    _, _, _, events = self.check([hit], body)
                    self.assertEqual(events, [])

    def test_web_cards_cannot_restore_a_cached_terminal_flag(self):
        for stage in ('delivered', 'cancelled'):
            view = tracker.delivery_cards.view(self.f.cfg, {'status': stage, 'last_confirmed_status': stage,
                                                           'whole_order_complete': True}, {})
            self.assertFalse(view['terminal'])
            self.assertEqual(view['stage'], 'Tracking pending')

    def test_actual_watcher_expiry_stops_tracking_after_each_mail_notice(self):
        runner = Path(__file__).resolve().parents[2] / 'robob-watch' / 'src' / 'runner.ts'
        bun = Path.home() / '.bun' / 'bin' / 'bun'
        for stage in ('delivered', 'cancelled'):
            with self.subTest(stage=stage):
                cfg, folder, _, events = self.check([self.f.hit(subject=f'Order #2606 {stage}')],
                                                   elapsed=(0, 49 * 3600, 72 * 3600))
                self.assertEqual(sum(e['kind'] == 'tracking_problem' for e in events), 1)
                created = tracker.epoch(cfg['registered_at'])
                expires = created + 7 * 86400
                tracker.write(folder / 'watcher.json', {'id': cfg['watcher'], 'title': 'Web fixture', 'check': 'exit 99',
                              'interval_s': 15, 'mode': 'wake', 'context': '', 'expires_at': tracker.stamp(expires),
                              'max_fires': 0, 'serial': False, 'created_at': cfg['registered_at'], 'created_by_session': None})
                tracker.write(folder / 'state.json', {'status': 'active', 'fires': 2, 'consecutive_failures': 0,
                                                     'failure_alerted': False})
                driver = folder / 'expiry-driver.ts'
                driver.write_text('''import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [runner, folder, id] = process.argv.slice(2);
const { tickOne } = await import(pathToFileURL(runner).href);
const watcher = JSON.parse(readFileSync(join(folder, "watcher.json"), "utf8"));
Date.now = () => Date.parse(watcher.expires_at) + 1;
await tickOne(id);
await tickOne(id);
const state = JSON.parse(readFileSync(join(folder, "state.json"), "utf8"));
if (state.status !== "expired") throw new Error("watcher did not expire");
console.log("ok");
''')
                stub = folder / 'expiry-alert.ts'
                alerts = folder / ('expiry-alerts-' + stage + '.jsonl')
                stub.write_text('''import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(''' + json.dumps(str(alerts)) + ''', JSON.stringify({key: args[args.indexOf("--key") + 1]}) + "\\n");
console.log(JSON.stringify({ok: true}));
''')
                env = {**tracker.store.clean_env(), 'ROBOB_TEST': '1', 'ROBOB_WATCH_ROOT': str(tracker.WATCHERS.parent),
                       'TOOLLOG_DIR': str(folder / 'logs'), 'ROBOB_WATCH_TELEGRAM_CLI': str(stub),
                       'ROBOB_WATCH_SPECTRUM_CLI': str(stub), 'ROBOB_WATCH_BRIDGE_DB': str(folder / 'bridge.sqlite')}
                result = subprocess.run([str(bun), str(driver), str(runner), str(folder), cfg['watcher']],
                                        capture_output=True, text=True, timeout=15, env=env)
                self.assertEqual(result.returncode, 0, 'isolated expiry driver failed')
                self.assertEqual(result.stdout.strip(), 'ok')
                self.assertEqual([json.loads(line)['key'] for line in alerts.read_text().splitlines()],
                                 ['robob-watch:' + cfg['watcher'] + ':expired'])


if __name__ == '__main__':
    main()

from contextlib import redirect_stdout
import datetime as dt
import hashlib
import io
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
import delivery_store as s
import order_tracker as t


class DeliveryTests(unittest.TestCase):
    def test_rows_are_bounded_sorted_and_read_only(self):
        with tempfile.TemporaryDirectory() as d, patch.object(s, 'ROOT', Path(d)):
            self.assertEqual(s.rows('careem', 10, 30), ([], ['notification_collector_stale']))
            self.assertFalse((s.ROOT / 'delivery.sqlite').exists())
            with s.connect() as db:
                db.execute('INSERT INTO health VALUES (?,?,?,?)', ('phone', time.time(), 1, 'ok'))
                for key, app, posted in [('one', 'careem', 30), ('two', 'careem', 10),
                                         ('three', 'careem', 31), ('four', 'noon', 20)]:
                    db.execute('INSERT INTO pushes VALUES (?,?,?,?,?,?)', (key, app, posted, posted+1, key, '[]'))
            with patch.object(s, 'connect', side_effect=AssertionError('read must not initialize journal')):
                rows, errors = s.rows('careem', 10, 30)
            self.assertEqual(errors, [])
            self.assertEqual(rows, [{'posted': 10, 'detected': 11, 'text': 'two'},
                                    {'posted': 30, 'detected': 31, 'text': 'one'}])
            with s.connect() as db:
                db.execute('UPDATE health SET ok=0, detail="priority_hold_stale"')
            self.assertEqual(s.rows('careem', 10, 30)[1], ['notifications_priority_hold_stale'])

    def test_real_talabat_wording_and_journal_survives_clear(self):
        with tempfile.TemporaryDirectory() as d, patch.object(s, 'ROOT', Path(d)):
            now = time.time()
            text = 'Your rider’s just around the corner! Give them a moment to drop off your order'
            dump = f'NotificationRecord(x: pkg=com.talabat id=1)\nwhen={int(now*1000)}\nandroid.text=SpannableString ({text})'
            with s.connect() as db:
                db.executemany('INSERT OR IGNORE INTO pushes VALUES (?,?,?,?,?,?)', s.parse_pushes(dump))
                db.executemany('INSERT OR IGNORE INTO pushes VALUES (?,?,?,?,?,?)', s.parse_pushes(dump))
                self.assertEqual(db.execute('SELECT count(*) FROM pushes').fetchone()[0], 1)
            cfg = {'app': 'talabat', 'order': '3941245276', 'placed_at': t.stamp(now-60)}
            rows, _ = s.evidence(cfg, t.classify, True)
            self.assertEqual(rows[0]['stage'], 'nearby')
            self.assertNotEqual(rows[0]['confidence'], 'exact_order')
            self.assertEqual(s.evidence(cfg, t.classify, False)[0][0]['confidence'], 'app_unassigned_unconfirmed')

    def test_environment_inspector_not_inherited(self):
        with patch.dict(os.environ, {'BUN_INSPECT': 'bad', 'BUN_INSPECT_CONNECT_TO': 'bad'}):
            self.assertFalse(any(k.startswith('BUN_INSPECT') for k in s.clean_env()))

    def test_reconciliation_preserves_first_detection(self):
        with tempfile.TemporaryDirectory() as d, patch.object(s, 'ROOT', Path(d)):
            cfg = {'app': 'talabat', 'order': '123', 'placed_at': '2026-10-07T12:55:00+04:00'}
            s.reconcile(cfg, detected='2026-10-07T13:26:00+04:00', source='push')
            row = s.reconcile(cfg, detected='2026-10-07T14:00:00+04:00', reported='2026-10-07T13:24:00+04:00')
            self.assertEqual(row['gap_seconds'], 120)

    def test_receipts_do_not_exhaust_delivery_read_budget(self):
        import json
        from types import SimpleNamespace
        hits = [{'subject': 'Your receipt', 'from': 'noreply@amazon.ae'},
                {'subject': 'Your return', 'from': 'return@amazon.ae'},
                {'subject': 'Delivered: "Cat Ball"', 'from': 'order-update@amazon.ae',
                 'account': 'gmail', 'folder': 'Inbox', 'uid': 1}]
        def response(args, timeout):
            return '{"envelopes":[]}' if args[1] == 'envelope' else 'Order # 408-5401303-9857106'
        with patch.object(t.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps({'hits': hits}))), patch.object(t, 'run', side_effect=response) as body:
            rows, errors = t.mail_evidence({'app':'amazon', 'order':'408-5401303-9857106', 'placed_at':'2026-10-05T21:15:00+04:00'})
            self.assertEqual(rows[0]['stage'], 'delivered')
            self.assertEqual(sum(c.args[0][1] in ('message', 'read') for c in body.call_args_list), 1)
            self.assertEqual(body.call_args_list[-1].args[0][:3], ['mailsearch', 'read', 'gmail'])
            self.assertEqual(errors, [])
            self.assertIn('after:2026/10/04', t.subprocess.run.call_args.args[0][-1])

    def test_marketing_is_not_delivery(self):
        self.assertEqual(t.classify('Halloween delivered fast Costumes, décor & treats delivered to your door in no time'), 'unknown')

    def test_amazon_second_shipment_wakes_without_closing_order(self):
        cfg = {'app': 'amazon', 'registered_at': t.stamp(), 'eta': None}
        state = {'primed': True}
        result = {'status': 'delivered', 'errors': [], 'evidence': [{'mail_key':'one'}]}
        self.assertEqual(t.transition(result, state, cfg, time.time())[0]['kind'], 'shipment_delivered')
        self.assertNotEqual(state.get('status'), 'delivered')
        self.assertEqual(t.transition(result, state, cfg, time.time()), [])
        result['evidence'][0]['mail_key'] = 'two'
        self.assertEqual(t.transition(result, state, cfg, time.time())[0]['kind'], 'shipment_delivered')


class DeliveryHoldTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.now = 1800000000
        self.owner = 'torssh-card102:fixture-owner'
        self.snapshots = {}
        for p in (patch.object(s, 'ROOT', self.folder / 'store'),
                  patch.object(s, 'PHONE_LOCK', self.folder / 'phone-lock'),
                  patch.object(s.time, 'time', return_value=self.now),
                  patch.dict(os.environ, {'TOOLLOG_ROOT': str(self.folder / 'logs'),
                                          'ROBOB_TOOL_LOG_DIR': str(self.folder / 'logs')})):
            p.start()
            self.addCleanup(p.stop)
        adb_patch = patch.object(s.subprocess, 'run', return_value=SimpleNamespace(
            returncode=0, stdout='Notification list'))
        self.adb = adb_patch.start()
        self.addCleanup(adb_patch.stop)

    def tearDown(self):
        self.assert_files_unchanged()

    def assert_files_unchanged(self):
        for path, (contents, mtime) in self.snapshots.items():
            self.assertTrue(path.exists(), str(path))
            self.assertEqual(path.read_bytes(), contents)
            self.assertEqual(path.stat().st_mtime_ns, mtime)

    def hold(self, age=600, owner=None):
        s.PHONE_LOCK.mkdir(exist_ok=True)
        path = s.PHONE_LOCK / 'priority-hold'
        path.write_text((self.owner if owner is None else owner) + '\n')
        os.utime(path, (self.now - age, self.now - age))
        self.remember(path)
        return path

    def lease(self, expiry=600, owner=None, pid=None):
        value = {'owner': self.owner if owner is None else owner,
                 'purpose': 'fixture', 'lease_id': 'fixture-lease',
                 'expires_at': dt.datetime.fromtimestamp(self.now + expiry, dt.timezone.utc)
                               .isoformat().replace('+00:00', 'Z'),
                 'pid': os.getpid() if pid is None else pid}
        path = s.PHONE_LOCK / 'lease.json'
        path.write_text(json.dumps(value))
        self.remember(path)
        return path

    def remember(self, path):
        self.snapshots[path] = (path.read_bytes(), path.stat().st_mtime_ns)

    def dead_pid(self):
        with subprocess.Popen([sys.executable, '-I', '-c', 'pass']) as child:
            self.assertEqual(child.wait(timeout=5), 0)
        return child.pid

    def health(self):
        with s.connect() as db:
            return dict(db.execute('SELECT * FROM health WHERE source="phone"').fetchone())

    def errors(self):
        cfg = {'app': 'amazon', 'order': '408-2932248-9569157', 'placed_at': t.stamp(self.now - 60)}
        return s.evidence(cfg, t.classify)[1]

    def check_deferred(self, reason):
        self.assertEqual(s.hold_state()['reason'], reason)
        output = io.StringIO()
        with redirect_stdout(output):
            s.health_check()
        self.assertEqual(output.getvalue(), '')
        self.assertFalse((s.ROOT / 'hold-alerts.json').exists())

    def health_output(self):
        output = io.StringIO()
        with redirect_stdout(output):
            s.health_check()
        self.assert_files_unchanged()
        return output.getvalue()

    def alert_logs(self):
        return [row for row in self.logs() if row['name'] == 'collector.hold_alert_sent']

    def test_matching_live_lease_never_alerts_within_age_bound(self):
        for age in (30 * 60, 60 * 60):
            with self.subTest(age=age):
                self.hold(age=age)
                self.lease()
                s.collect()
                self.check_deferred('lease_live')
                self.assert_files_unchanged()
        self.assertEqual(self.alert_logs(), [])
        self.adb.assert_not_called()

    def test_no_lease_is_silent_until_strict_alert_boundary(self):
        for age in (10 * 60, 15 * 60):
            with self.subTest(age=age):
                self.hold(age=age)
                s.collect()
                self.check_deferred('no_matching_lease_within_bound')
                self.assert_files_unchanged()
        self.assertEqual(self.alert_logs(), [])

    def test_no_lease_alerts_once_and_records_identity_and_log(self):
        path = self.hold(age=16 * 60)
        s.collect()
        output = self.health_output()
        self.assertEqual(len(output.splitlines()), 1)
        self.assertEqual(json.loads(output), {
            'status': 'alert', 'reason': 'phone_priority_hold_without_lease',
            'owner': self.owner, 'age_min': 16, 'collection': 'blocked',
            'note': 'delivery notifications are not being collected; the holder has no lease; '
                    "ask the holder to release it, never remove another task's hold"})
        alert_id = hashlib.sha256((self.owner + '|' + str(int(path.stat().st_mtime))).encode()).hexdigest()
        self.assertEqual(json.loads((s.ROOT / 'hold-alerts.json').read_text()), [alert_id])
        self.assertEqual(self.health_output(), '')
        with patch.object(s.time, 'time', return_value=self.now + 60):
            self.assertEqual(self.health_output(), '')
        self.assertEqual(len(self.alert_logs()), 1)
        self.assertEqual(self.alert_logs()[0]['props'], {
            'owner': self.owner, 'age_s': 960, 'reason': 'no_matching_lease_within_bound'})
        self.assertEqual(list(s.ROOT.glob('hold-alerts-*.tmp')), [])

    def test_no_lease_alert_boundary_and_last_live_second(self):
        for age, minutes in ((901, 15), (3600, 60)):
            with self.subTest(age=age):
                self.hold(age=age)
                s.collect()
                self.assertEqual(json.loads(self.health_output())['age_min'], minutes)
                self.assertEqual(self.health_output(), '')

    def test_rewritten_hold_alerts_once_for_each_new_mtime(self):
        path = self.hold(age=16 * 60)
        s.collect()
        self.assertEqual(json.loads(self.health_output())['status'], 'alert')
        os.utime(path, (self.now - 17 * 60, self.now - 17 * 60))
        self.remember(path)
        self.assertEqual(json.loads(self.health_output())['age_min'], 17)
        self.assertEqual(self.health_output(), '')
        self.assertEqual(len(json.loads((s.ROOT / 'hold-alerts.json').read_text())), 2)
        self.assertEqual(len(self.alert_logs()), 2)

    def test_different_owner_at_same_mtime_alerts_again(self):
        self.hold(age=960)
        s.collect()
        self.assertEqual(json.loads(self.health_output())['owner'], self.owner)
        self.hold(age=960, owner='other-owner')
        self.assertEqual(json.loads(self.health_output())['owner'], 'other-owner')
        self.assertEqual(self.health_output(), '')
        self.assertEqual(len(json.loads((s.ROOT / 'hold-alerts.json').read_text())), 2)

    def test_corrupt_alert_record_is_replaced_and_dedupes(self):
        self.hold(age=960)
        self.lease(owner='other-owner')
        s.collect()
        record = s.ROOT / 'hold-alerts.json'
        for contents in (b'{broken', b'\xff', b'null', b'{}', b'"id"', b'[1, null]'):
            with self.subTest(contents=contents):
                record.write_bytes(contents)
                self.assertEqual(json.loads(self.health_output())['status'], 'alert')
                self.assertEqual(self.health_output(), '')
                self.assertEqual(len(json.loads(record.read_text())), 1)
        self.assertEqual(len(self.alert_logs()), 6)

    def test_alert_history_keeps_last_50_entries_atomically(self):
        self.hold(age=960)
        s.collect()
        record = s.ROOT / 'hold-alerts.json'
        sent = ['old-{}'.format(index) for index in range(50)]
        record.write_text(json.dumps(sent))
        replace = s.os.replace
        def check_replace(source, destination):
            self.assertEqual(json.loads(record.read_text()), sent)
            self.assertEqual(source.parent, s.ROOT)
            self.assertEqual(destination, record)
            self.assertEqual(len(json.loads(source.read_text())), 50)
            replace(source, destination)
        with patch.object(s.os, 'replace', side_effect=check_replace) as atomic:
            self.assertEqual(json.loads(self.health_output())['status'], 'alert')
        atomic.assert_called_once()
        self.assertEqual(json.loads(record.read_text())[:-1], sent[1:])
        self.assertEqual(self.health_output(), '')

    def test_hold_gone_with_deferred_row_is_silent(self):
        path = self.hold()
        self.lease()
        s.collect()
        # The fixture releases its own hold while the collector row lags.
        path.unlink()
        del self.snapshots[path]
        self.assertEqual(self.health_output(), '')
        self.assertFalse((s.ROOT / 'hold-alerts.json').exists())
        self.assertEqual(self.alert_logs(), [])

    def test_stale_hold_fails_without_alert_output_or_record(self):
        self.hold(age=61 * 60)
        s.collect()
        output = io.StringIO()
        with redirect_stdout(output):
            with self.assertRaisesRegex(RuntimeError, 'hold_older_than_60m'):
                s.health_check()
        self.assertEqual(output.getvalue(), '')
        self.assertFalse((s.ROOT / 'hold-alerts.json').exists())
        self.assertEqual(self.alert_logs(), [])

    def logs(self):
        return [json.loads(line) for path in (self.folder / 'logs/orders').glob('*.ndjson')
                for line in path.read_text().splitlines()]

    def test_no_hold_collects_and_retains_notification(self):
        self.assertIsNone(s.hold_state())
        self.adb.return_value.stdout = (
            'NotificationRecord(x: pkg=com.amazon.mShop.android.shopping id=1)\n'
            'when={}\nandroid.text=String (Order 408-2932248-9569157 delivered)'.format(self.now * 1000))
        s.collect()
        self.adb.assert_called_once()
        self.assertEqual((self.health()['ok'], self.health()['detail']), (1, 'ok'))
        self.assertEqual(s.rows('amazon', self.now - 60, self.now)[0][0]['posted'], self.now)
        s.health_check()
        self.assertEqual(self.errors(), [])
        self.assertEqual(self.logs(), [])

    def test_no_hold_adb_failure_still_fails_health(self):
        self.adb.return_value.returncode = 1
        s.collect()
        with self.assertRaisesRegex(RuntimeError, 'notification collection unavailable: RuntimeError'):
            s.health_check()
        self.assertEqual(self.errors(), ['notifications_RuntimeError'])

    def test_live_matching_lease_defers_without_errors_or_adb(self):
        self.hold()
        self.lease()
        state = s.hold_state()
        self.assertEqual((state['state'], state['reason'], state['pid']),
                         ('live', 'lease_live', os.getpid()))
        self.assertTrue(state['lease_expires_at'].endswith('Z'))
        s.collect()
        self.assertEqual((self.health()['ok'], self.health()['detail']), (1, 'deferred_priority_hold'))
        self.check_deferred('lease_live')
        self.assertEqual(self.errors(), [])
        self.assertEqual(s.rows('amazon', 0, self.now)[1], [])
        self.adb.assert_not_called()

    def test_dead_lease_pid_is_live_before_lease_expiry(self):
        self.hold(age=10)
        pid = self.dead_pid()
        self.lease(pid=pid)
        state = s.hold_state()
        self.assertEqual((state['state'], state['reason'], state['pid']),
                         ('live', 'lease_live', pid))
        s.collect()
        self.check_deferred('lease_live')
        self.assertEqual((self.health()['ok'], self.health()['detail']), (1, 'deferred_priority_hold'))
        self.assertEqual(self.errors(), [])
        self.adb.assert_not_called()

    def test_expired_lease_precedes_dead_pid(self):
        self.hold(age=10)
        self.lease(expiry=-1, pid=self.dead_pid())
        with patch.object(s.os, 'kill') as kill:
            s.collect()
            self.assertEqual(s.hold_state()['reason'], 'lease_expired')
            with self.assertRaisesRegex(RuntimeError, 'lease_expired'):
                s.health_check()
            kill.assert_not_called()
        self.adb.assert_not_called()

    def test_age_limit_precedes_unexpired_lease_with_dead_pid(self):
        self.hold(age=61 * 60)
        self.lease(pid=self.dead_pid())
        s.collect()
        self.assertEqual(s.hold_state()['reason'], 'hold_older_than_60m')
        with self.assertRaisesRegex(RuntimeError, 'hold_older_than_60m'):
            s.health_check()
        self.assertEqual(self.errors(), ['notifications_priority_hold_stale'])
        self.adb.assert_not_called()

    def test_live_lease_never_probes_pid(self):
        self.hold()
        self.lease()
        with patch.object(s.os, 'kill', side_effect=AssertionError('lease pid is not a liveness probe')):
            s.collect()
            self.check_deferred('lease_live')
        self.adb.assert_not_called()

    def test_invalid_pid_metadata_never_probes_process_groups(self):
        self.hold()
        for pid in (0, -1, True, '123', 2147483648, 1.5, {}, []):
            with self.subTest(pid=pid), patch.object(s.os, 'kill') as kill:
                self.lease(pid=pid)
                s.collect()
                self.assertEqual(s.hold_state()['state'], 'live')
                self.assertEqual(s.hold_state()['reason'], 'no_matching_lease_within_bound')
                self.assertIsNone(s.hold_state()['pid'])
                kill.assert_not_called()
                self.assert_files_unchanged()
        self.adb.assert_not_called()

    def test_malformed_matching_lease_fields_do_not_make_hold_stale(self):
        self.hold()
        path = self.lease()
        valid = json.loads(path.read_text())
        forms = [dict(valid, expires_at=value) for value in
                 (None, '', 'invalid', '2026-02-30T00:00:00Z', '2020-01-01T00:00:00',
                  123, True, {}, [])]
        forms += [dict(valid, pid=value) for value in (None, 0, -1, True, '123', 1.5, {}, [], 2147483648)]
        forms += [{k: v for k, v in valid.items() if k != missing} for missing in ('owner', 'pid', 'expires_at')]
        forms += [dict(valid, owner=value) for value in (None, '', 123, {}, [])]
        for lease in forms:
            with self.subTest(lease=lease), patch.object(s.os, 'kill', side_effect=ProcessLookupError) as kill:
                path.write_text(json.dumps(lease))
                self.remember(path)
                s.collect()
                self.check_deferred('no_matching_lease_within_bound')
                self.assertEqual(self.errors(), [])
                kill.assert_not_called()
                self.assert_files_unchanged()
        self.adb.assert_not_called()

    def test_lease_timestamp_formats_preserve_expiry_checks(self):
        self.hold()
        path = self.lease()
        lease = json.loads(path.read_text())
        for expires in ('2020-01-01T00:00:00Z', '2020-01-01T00:00:00+00:00',
                        '2020-01-01T04:00:00+04:00', '2020-01-01T00:00:00.123456Z'):
            with self.subTest(expires=expires):
                lease['expires_at'] = expires
                path.write_text(json.dumps(lease))
                self.remember(path)
                s.collect()
                with self.assertRaisesRegex(RuntimeError, 'lease_expired'):
                    s.health_check()
                self.assert_files_unchanged()
        self.adb.assert_not_called()

    def test_nonregular_hold_entries_block_adb_and_remain_untouched(self):
        s.PHONE_LOCK.mkdir()
        target = s.PHONE_LOCK / 'owner-target'
        target.write_text(self.owner)
        self.remember(target)
        for kind in ('symlink', 'dangling_symlink', 'directory', 'fifo'):
            with self.subTest(kind=kind):
                path = s.PHONE_LOCK / 'priority-hold'
                if kind in ('symlink', 'dangling_symlink'):
                    path.symlink_to(target if kind == 'symlink' else s.PHONE_LOCK / 'missing')
                elif kind == 'directory':
                    path.mkdir()
                else:
                    os.mkfifo(path)
                os.utime(path, (self.now - 600, self.now - 600), follow_symlinks=False)
                metadata = path.lstat()
                link = os.readlink(path) if path.is_symlink() else None
                s.collect()
                self.assertEqual(s.hold_state()['state'], 'live')
                self.assertEqual(self.health()['detail'], 'deferred_priority_hold')
                after = path.lstat()
                for field in ('st_mode', 'st_ino', 'st_size', 'st_mtime_ns'):
                    self.assertEqual(getattr(after, field), getattr(metadata, field))
                if link is not None:
                    self.assertEqual(os.readlink(path), link)
                self.assert_files_unchanged()
                # The fixture owns this entry and clears it between shapes.
                path.rmdir() if kind == 'directory' else path.unlink()
        self.adb.assert_not_called()

    def test_empty_invalid_or_unreadable_hold_owner_still_blocks(self):
        path = self.hold()
        for contents in (b'', b'\xff', b'owner\nsecond line'):
            with self.subTest(contents=contents):
                path.write_bytes(contents)
                os.utime(path, (self.now - 600, self.now - 600))
                self.remember(path)
                s.collect()
                self.assertEqual(self.health()['detail'], 'deferred_priority_hold')
                self.assert_files_unchanged()
        with patch.object(s.Path, 'open', side_effect=PermissionError):
            s.collect()
            self.assertEqual(s.hold_state()['state'], 'live')
        self.adb.assert_not_called()

    def test_lease_free_age_boundary_is_live(self):
        self.hold(age=3600)
        self.assertEqual(s.hold_state()['state'], 'live')
        s.collect()
        self.assertEqual(self.health()['ok'], 1)
        self.adb.assert_not_called()

    def test_lease_free_hold_defers_within_bound(self):
        self.hold()
        s.collect()
        self.check_deferred('no_matching_lease_within_bound')
        self.assertEqual(self.errors(), [])
        self.adb.assert_not_called()

    def test_lease_free_old_hold_is_stale(self):
        self.hold(age=61 * 60)
        s.collect()
        with self.assertRaisesRegex(RuntimeError, 'hold_older_than_60m'):
            s.health_check()
        self.assertEqual(self.errors(), ['notifications_priority_hold_stale'])
        self.adb.assert_not_called()

    def test_age_limit_precedes_lease_checks_and_is_strict(self):
        self.hold(age=3600)
        self.lease(expiry=-1)
        self.assertEqual(s.hold_state()['reason'], 'lease_expired')
        self.hold(age=3601)
        with patch.object(s.os, 'kill') as kill:
            s.collect()
            self.assertEqual(s.hold_state()['reason'], 'hold_older_than_60m')
            kill.assert_not_called()
        self.adb.assert_not_called()

    def test_other_owner_expired_lease_does_not_apply(self):
        self.hold()
        self.lease(expiry=-1, owner='other-owner')
        with patch.object(s.os, 'kill') as kill:
            s.collect()
            self.check_deferred('no_matching_lease_within_bound')
            kill.assert_not_called()
        self.adb.assert_not_called()

    def test_malformed_and_non_object_leases_defer(self):
        self.hold()
        path = s.PHONE_LOCK / 'lease.json'
        for contents in (b'{broken', b'[]', b'null', b'"owner"', b'\xff'):
            with self.subTest(contents=contents):
                path.write_bytes(contents)
                self.remember(path)
                s.collect()
                self.check_deferred('no_matching_lease_within_bound')
                self.assert_files_unchanged()
        self.adb.assert_not_called()

    def test_unreadable_lease_defers(self):
        self.hold()
        self.lease()
        with patch.object(s.Path, 'read_text', side_effect=PermissionError):
            s.collect()
            self.check_deferred('no_matching_lease_within_bound')
        self.adb.assert_not_called()

    def test_owner_is_first_line_bounded_without_truncating_lease_match(self):
        full_owner = 'x' * 121
        self.hold(owner=full_owner + '\nignored-line')
        self.lease(owner=full_owner)
        state = s.hold_state()
        self.assertEqual(state['owner'], 'x' * 120)
        self.assertEqual(state['reason'], 'lease_live')
        self.lease(expiry=-1, owner='x' * 120)
        self.assertEqual(s.hold_state()['reason'], 'no_matching_lease_within_bound')

    def test_health_keeps_deferred_row_healthy_after_lease_process_exits(self):
        self.hold(age=10)
        with subprocess.Popen([sys.executable, '-I', '-c', 'import sys; sys.stdin.read()'],
                              stdin=subprocess.PIPE) as child:
            self.lease(pid=child.pid)
            s.collect()
            child.communicate(timeout=5)
            self.assertEqual(child.returncode, 0)
        self.check_deferred('lease_live')
        self.assertEqual(s.hold_state()['pid'], child.pid)
        self.adb.assert_not_called()

    def test_health_recomputes_when_lease_expires_or_age_exceeds_bound(self):
        self.hold()
        self.lease(expiry=1)
        s.collect()
        with patch.object(s.time, 'time', return_value=self.now + 2):
            with self.assertRaisesRegex(RuntimeError, 'lease_expired'):
                s.health_check()
        self.hold(age=3599)
        self.lease(expiry=600)
        s.collect()
        with patch.object(s.time, 'time', return_value=self.now + 2):
            with self.assertRaisesRegex(RuntimeError, 'hold_older_than_60m'):
                s.health_check()
        self.adb.assert_not_called()

    def test_health_recomputes_stale_row_after_renewal_or_clear(self):
        path = self.hold()
        self.lease(expiry=-1)
        s.collect()
        self.lease()
        self.check_deferred('lease_live')
        # Simulate the holder clearing its own fixture, never the collector.
        path.unlink()
        del self.snapshots[path]
        output = io.StringIO()
        with redirect_stdout(output):
            s.health_check()
        self.assertEqual(output.getvalue(), '')
        self.adb.assert_not_called()

    def test_deferred_row_still_expires_if_collector_stops(self):
        self.hold()
        s.collect()
        with patch.object(s.time, 'time', return_value=self.now + 121):
            with self.assertRaisesRegex(RuntimeError, 'notification collector is stale'):
                s.health_check()
            self.assertEqual(self.errors(), ['notification_collector_stale'])
        self.adb.assert_not_called()

    def test_hold_transitions_log_once_and_refresh_checked(self):
        path = self.hold()
        self.lease()
        s.collect()
        with patch.object(s.time, 'time', return_value=self.now + 15):
            s.collect()
        self.assertEqual(self.health()['checked'], self.now + 15)
        self.assertEqual(len(self.logs()), 1)
        row = self.logs()[0]
        self.assertIn('ts', row)
        self.assertEqual(row['props'], {'owner': self.owner, 'reason': 'lease_live', 'age_s': 600})
        self.assertNotIn('fixture-lease', json.dumps(row))
        self.lease(expiry=-1)
        s.collect()
        s.collect()
        self.adb.assert_not_called()
        path.unlink()
        del self.snapshots[path]
        s.collect()
        s.collect()
        self.assertEqual([r['name'] for r in self.logs()], [
            'collector.hold_seen', 'collector.hold_stale', 'collector.hold_cleared'])
        self.assertEqual(self.logs()[-1]['props'], {'owner': None, 'reason': 'hold_absent', 'age_s': None})

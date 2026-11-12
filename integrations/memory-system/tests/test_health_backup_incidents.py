"""Backup incidents: fixture status, launchctl and notifier; no live data."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import health_check as hc


class BackupIncidents(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.notices = self.root / 'notices'
        self.deliveries = self.root / 'deliveries'
        command = self.root / 'notify.py'
        command.write_text("""import json, os, pathlib, sys
assert 'BUN_INSPECT' not in os.environ
with open(os.environ['NOTICE_LOG'], 'a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\\n')
failed = int(os.environ.get('NOTICE_FAIL', '0'))
if not failed:
    path = pathlib.Path(os.environ['DELIVERY_LOG'])
    prior = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
    key = sys.argv[sys.argv.index('--key') + 1]
    existing = next((row for row in prior if row[row.index('--key') + 1] == key), None)
    if existing is not None and existing != sys.argv[1:]:
        sys.exit(1)
    if existing is None:
        with path.open('a') as f:
            f.write(json.dumps(sys.argv[1:]) + '\\n')
sys.exit(failed)
""")
        launchctl = self.root / 'launchctl'
        launchctl.write_text("""#!/usr/bin/python3
import os, sys
assert sys.argv[1] == 'print'
label = sys.argv[2].rsplit('/', 1)[-1]
if label not in os.environ.get('LOADED', '').split(','):
    print('Could not find service', file=sys.stderr)
    sys.exit(113)
print(label + ' = {\\n state = not running\\n runs = 1\\n}')
""")
        launchctl.chmod(0o755)
        self.loaded = ','.join('com.abdullah.' + x for x in hc.BACKUP_INCIDENTS.values())
        patches = [mock.patch.dict(os.environ, {
            'PATH': str(self.root) + os.pathsep + os.environ['PATH'], 'LOADED': self.loaded,
            'MEMORY_BACKUP_NOTIFY_CMD': '/usr/bin/python3 ' + str(command),
            'NOTICE_LOG': str(self.notices), 'DELIVERY_LOG': str(self.deliveries),
            'BUN_INSPECT': 'must-be-removed'}),
            mock.patch.object(hc, 'LOGS', str(self.root)),
            mock.patch.object(hc, 'STATE', str(self.root / 'state.json')),
            mock.patch.object(hc, 'LAST', str(self.root / 'last.json')),
            mock.patch.object(hc, 'HEALTH_BACKUP_STATUS', str(self.root / 'health.json')),
            mock.patch.object(hc, 'PERSON_BACKUP_DIR', str(self.root / 'people')),
            mock.patch.object(sys, 'argv', ['health_check.py'])]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.status()

    def status(self, **fields):
        self.st = {'ok': True, 'last_success_ts': time.time() - 60, 'last_snapshot': 'fixture'}
        self.st.update(fields)
        (self.root / 'backup_last.json').write_text(json.dumps(self.st))

    def tick(self, check=hc.check_backup, name='backup'):
        with mock.patch.object(hc, 'CHECKS', [(name, check)]):
            hc.main()

    def sent(self):
        return [json.loads(s) for s in self.notices.read_text().splitlines()] if self.notices.exists() else []

    def delivered(self):
        return [json.loads(s) for s in self.deliveries.read_text().splitlines()] if self.deliveries.exists() else []

    def reset_notices_and_state(self):
        for path in (Path(hc.STATE), Path(hc.LAST), self.notices, self.deliveries):
            path.unlink(missing_ok=True)

    def fail_state_replacement(self, after_send):
        replace = os.replace
        attempts = len(self.sent())
        def fail(src, dst):
            if dst == hc.STATE and (len(self.sent()) > attempts) == after_send:
                raise OSError('fixture state replacement failed')
            return replace(src, dst)
        return mock.patch.object(hc.os, 'replace', side_effect=fail)

    def test_unloaded_once_across_days_recovery_once_and_new_incident(self):
        os.environ['LOADED'] = ''
        self.tick()
        with mock.patch.object(hc.time, 'strftime', return_value='20991231'):
            self.tick()
        self.assertEqual(len(self.sent()), 1)
        self.assertIn('not loaded', self.sent()[0][-1])
        os.environ['LOADED'] = self.loaded
        self.tick()
        self.tick()
        self.assertEqual(len(self.sent()), 2)
        self.assertIn('recovered', self.sent()[1][-1])
        os.environ['LOADED'] = ''
        self.tick()
        self.assertEqual(len(self.sent()), 3)
        self.assertNotEqual(self.sent()[0][3], self.sent()[2][3])

    def test_fresh_success_passes_even_if_latest_run_failed(self):
        self.status(ok=False, stage='replica', message='failed run')
        self.tick()
        self.assertEqual(self.sent(), [])

    def test_stale_loaded_alerts(self):
        self.status(last_success_ts=time.time() - 10 * 3600)
        self.tick()
        self.assertIn('10 h ago', self.sent()[0][-1])

    def test_stale_deferral_reason_forms(self):
        for field in ('deferred_reason', 'last_deferred_reason', 'message'):
            with self.subTest(field=field):
                self.status(last_success_ts=time.time() - 10 * 3600,
                            last_deferred_ts=time.time() - 100, deferred_count=3,
                            **{field: 'load 170 exceeds limit'})
                ok, msg = hc.check_backup()
                self.assertFalse(ok)
                self.assertIn('deferred 3 time(s): load 170 exceeds limit', msg)
        self.tick()
        self.assertIn('load 170 exceeds limit', self.sent()[0][-1])

    def test_deferral_before_success_does_not_explain_later_staleness(self):
        self.status(last_success_ts=time.time() - 10 * 3600,
                    last_deferred_ts=time.time() - 20 * 3600, deferred_count=2)
        self.assertNotIn('deferred', hc.check_backup()[1])

    def test_deferral_never_hides_staleness_or_alerts_while_fresh(self):
        self.status(last_deferred_ts=time.time() - 10, deferred_count=1, message='high load')
        self.assertTrue(hc.check_backup()[0])
        self.status(last_success_ts=0, last_deferred_ts=time.time() - 10, deferred_count=1)
        ok, msg = hc.check_backup()
        self.assertFalse(ok)
        self.assertIn('reason not recorded', msg)

    def test_missing_malformed_and_invalid_success(self):
        for content in (None, '{', '[]', '{}', '{"last_success_ts":"bad"}',
                        '{"last_success_ts":true}', '{"last_success_ts":1e99}'):
            with self.subTest(content=content):
                path = self.root / 'backup_last.json'
                if content is None:
                    path.unlink()
                else:
                    path.write_text(content)
                self.assertFalse(hc.check_backup()[0])

    def test_unloaded_reported_even_if_status_missing(self):
        os.environ['LOADED'] = ''
        (self.root / 'backup_last.json').unlink()
        self.assertIn('not loaded', hc.check_backup()[1])

    def test_failed_notification_and_recovery_retry(self):
        os.environ['LOADED'] = ''
        os.environ['NOTICE_FAIL'] = '1'
        self.tick()
        os.environ['NOTICE_FAIL'] = '0'
        self.tick()
        self.assertEqual(self.sent()[0], self.sent()[1])
        os.environ['LOADED'] = self.loaded
        os.environ['NOTICE_FAIL'] = '1'
        self.tick()
        os.environ['NOTICE_FAIL'] = '0'
        self.tick()
        self.tick()
        self.assertEqual(len(self.sent()), 4)
        self.assertEqual(self.sent()[2], self.sent()[3])

    def test_new_outage_after_failed_recovery_is_a_new_incident(self):
        os.environ['LOADED'] = ''
        self.tick()
        first = self.sent()[0]
        os.environ['LOADED'] = self.loaded
        os.environ['NOTICE_FAIL'] = '1'
        self.tick()
        os.environ['LOADED'] = ''
        os.environ['NOTICE_FAIL'] = '0'
        self.tick()
        alerts = [row for row in self.sent() if row[1] == 'attention']
        self.assertEqual(len(alerts), 2)
        self.assertNotEqual(alerts[0][3], alerts[1][3])
        self.assertIn('recovered at', self.sent()[-1][-1])
        self.tick()
        self.assertEqual(len([row for row in self.sent() if row[1] == 'attention']), 2)
        self.assertEqual(first, alerts[0])

    def test_other_notifier_errors_do_not_break_incident_persistence(self):
        run = hc.subprocess.run
        for error in (OSError('missing notifier'), subprocess.TimeoutExpired('notify', 60)):
            with self.subTest(error=error):
                if Path(hc.STATE).exists():
                    Path(hc.STATE).unlink()
                self.notices.write_text('')
                os.environ['LOADED'] = ''
                def stub(cmd, **kwargs):
                    if cmd[0] == hc.BUN:
                        raise error
                    return run(cmd, **kwargs)
                with mock.patch.object(hc.subprocess, 'run', side_effect=stub), mock.patch.object(
                        hc, 'CHECKS', [('backup', hc.check_backup), ('disk', lambda: (False, 'full'))]):
                    hc.main()
                    hc.main()
                self.assertEqual(len(self.sent()), 1)
                state = json.loads(Path(hc.STATE).read_text())
                self.assertTrue(state['failing']['backup']['incident_notified'])

    def test_old_daily_alert_state_migrates_without_duplicate(self):
        Path(hc.STATE).write_text(json.dumps({'failing': {'backup': {
            'since': 123, 'notified_day': '20261101', 'msg': 'old incident'}}}))
        os.environ['LOADED'] = ''
        self.tick()
        self.assertEqual(self.sent(), [])
        os.environ['LOADED'] = self.loaded
        self.tick()
        self.assertEqual(len(self.sent()), 1)
        self.assertIn('recovered:123', self.sent()[0][3])

    def test_failed_reservation_sends_nothing(self):
        for name in hc.BACKUP_INCIDENTS:
            with self.subTest(name=name):
                self.reset_notices_and_state()
                with self.fail_state_replacement(after_send=False), self.assertRaises(OSError):
                    self.tick(lambda: (False, 'fixture outage'), name)
                self.assertEqual(self.sent(), [])
                self.assertFalse(Path(hc.STATE).exists())
                self.tick(lambda: (False, 'fixture outage'), name)
                self.assertEqual(len(self.delivered()), 1)

    def test_failed_post_send_state_write_reuses_persisted_key(self):
        for name in hc.BACKUP_INCIDENTS:
            with self.subTest(name=name):
                self.reset_notices_and_state()
                with self.fail_state_replacement(after_send=True), self.assertRaises(OSError):
                    self.tick(lambda: (False, 'fixture outage'), name)
                prior = json.loads(Path(hc.STATE).read_text())['failing'][name]
                self.assertFalse(prior['incident_notified'])
                self.assertTrue(self.sent()[0][3].endswith(':' + str(prior['since'])))
                self.tick(lambda: (False, 'fixture outage'), name)
                self.tick(lambda: (False, 'fixture outage'), name)
                self.assertEqual(len(self.sent()), 2)
                self.assertEqual(self.sent()[0], self.sent()[1])
                self.assertEqual(len(self.delivered()), 1)
                current = json.loads(Path(hc.STATE).read_text())['failing'][name]
                self.assertEqual(current['since'], prior['since'])
                self.assertTrue(current['incident_notified'])

    def test_process_stop_after_send_reuses_reserved_key(self):
        notify = hc.notify_backup
        for name in hc.BACKUP_INCIDENTS:
            with self.subTest(name=name):
                self.reset_notices_and_state()
                def stop_after_send(name, text, incident, recovered=False):
                    reserved = json.loads(Path(hc.STATE).read_text())['failing'][name]
                    self.assertEqual(reserved['since'], incident)
                    self.assertFalse(reserved['incident_notified'])
                    notify(name, text, incident, recovered)
                    raise SystemExit('fixture process stopped after send')
                with mock.patch.object(hc, 'notify_backup', side_effect=stop_after_send), self.assertRaises(SystemExit):
                    self.tick(lambda: (False, 'fixture outage'), name)
                self.tick(lambda: (False, 'fixture outage'), name)
                self.assertEqual(self.sent()[0], self.sent()[1])
                self.assertEqual(len(self.delivered()), 1)

    def test_pending_alert_payload_survives_changed_status(self):
        messages = [('last successful backup 10 h ago', 'last successful backup 11 h ago'),
                    ('backup job not loaded', 'last successful backup 11 h ago'),
                    ('deferred 3 times: high load', 'deferred 4 times: boot grace')]
        for name in hc.BACKUP_INCIDENTS:
            for first, current in messages:
                with self.subTest(name=name, first=first, current=current):
                    self.reset_notices_and_state()
                    with self.fail_state_replacement(after_send=True), self.assertRaises(OSError):
                        self.tick(lambda: (False, first), name)
                    self.tick(lambda: (False, current), name)
                    self.assertEqual(self.sent()[0], self.sent()[1])
                    self.assertEqual(len(self.delivered()), 1)
                    incident = json.loads(Path(hc.STATE).read_text())['failing'][name]
                    self.assertTrue(incident['incident_notified'])
                    self.assertEqual(incident['alert_text'], first)
                    self.assertEqual(incident['msg'], current)

    def test_backup_interruption_preserves_other_recovery_notices(self):
        notify = hc.notify_backup
        for name in ('disk', 'sync'):
            with self.subTest(name=name):
                self.reset_notices_and_state()
                Path(hc.STATE).write_text(json.dumps({'failing': {
                    name: {'since': 123, 'msg': 'old failure', 'notified_day': '20261112'}}}))
                checks = [('backup', lambda: (False, 'backup outage')), (name, lambda: (True, 'healthy'))]
                def stop_after_send(*args, **kwargs):
                    notify(*args, **kwargs)
                    raise SystemExit('fixture stop before ordinary all-clear')
                with mock.patch.object(hc, 'CHECKS', checks), mock.patch.object(hc, 'notify', return_value=True) as ordinary:
                    with mock.patch.object(hc, 'notify_backup', side_effect=stop_after_send), self.assertRaises(SystemExit):
                        hc.main()
                    ordinary.assert_not_called()
                    self.assertIn(name, json.loads(Path(hc.STATE).read_text())['failing'])
                    hc.main()
                    ordinary.assert_called_once()
                    self.assertEqual(ordinary.call_args.args[0], 'info')
                    self.assertIn(name, ordinary.call_args.args[1])
                    self.assertNotIn(name, json.loads(Path(hc.STATE).read_text())['failing'])

    def test_failed_other_recovery_delivery_keeps_its_record(self):
        for name in ('disk', 'sync'):
            with self.subTest(name=name):
                self.reset_notices_and_state()
                Path(hc.STATE).write_text(json.dumps({'failing': {
                    name: {'since': 123, 'msg': 'old failure', 'notified_day': '20261112'}}}))
                with mock.patch.object(hc, 'CHECKS', [(name, lambda: (True, 'healthy'))]), mock.patch.object(
                        hc, 'notify', side_effect=[False, True]) as ordinary:
                    hc.main()
                    pending = json.loads(Path(hc.STATE).read_text())['failing'][name]
                    self.assertTrue(pending['recovery_pending'])
                    hc.main()
                    self.assertEqual(ordinary.call_count, 2)
                    self.assertNotIn(name, json.loads(Path(hc.STATE).read_text())['failing'])

    def test_new_ordinary_outage_after_pending_recovery_alerts_again(self):
        for name in ('disk', 'sync', 'msgs'):
            for recovery_result in ('rejected', 'accepted-timeout'):
                with self.subTest(name=name, recovery_result=recovery_result):
                    self.reset_notices_and_state()
                    current = {'ok': False, 'msg': 'first outage'}
                    queued = {}
                    attempts = []
                    def send(cmd, **kwargs):
                        self.assertEqual(cmd[0], hc.BUN)
                        key = cmd[cmd.index('--key') + 1]
                        text = cmd[cmd.index('--text') + 1]
                        attempts.append((key, text))
                        recovering = text.startswith('Memory system recovered:')
                        if recovering and recovery_result == 'rejected':
                            return subprocess.CompletedProcess(cmd, 1, '', 'rejected')
                        if key in queued:
                            self.assertEqual(queued[key], text)
                        queued[key] = text
                        if recovering and recovery_result == 'accepted-timeout':
                            raise subprocess.TimeoutExpired(cmd, 60)
                        return subprocess.CompletedProcess(cmd, 0, '', '')
                    with mock.patch.object(hc, 'CHECKS', [(name, lambda: (current['ok'], current['msg']))]), mock.patch.object(
                            hc.subprocess, 'run', side_effect=send), mock.patch.object(
                            hc.time, 'strftime', return_value='20261112'):
                        with mock.patch.object(hc.time, 'time', return_value=100):
                            hc.main()
                        first = json.loads(Path(hc.STATE).read_text())['failing'][name]
                        current.update(ok=True, msg='healthy')
                        with mock.patch.object(hc.time, 'time', return_value=115):
                            hc.main()
                        pending = json.loads(Path(hc.STATE).read_text())['failing'][name]
                        self.assertTrue(pending['recovery_pending'])
                        current.update(ok=False, msg='second outage')
                        with mock.patch.object(hc.time, 'time', return_value=130):
                            hc.main()
                    new = json.loads(Path(hc.STATE).read_text())['failing'][name]
                    self.assertEqual(len(attempts), 3)
                    self.assertIn('second outage', attempts[-1][1])
                    self.assertNotEqual(attempts[0][0], attempts[-1][0])
                    self.assertNotEqual(new['since'], first['since'])
                    self.assertNotIn('recovery_pending', new)
                    self.assertEqual(new['notified_day'], first['notified_day'])
                    self.assertEqual(sum(text.startswith('Memory system problem:') for text in queued.values()), 2)

    def test_state_write_failure_does_not_suppress_ordinary_alerts(self):
        for name in ('disk', 'sync'):
            for backup_state in ('healthy', 'outage', 'recovery'):
                with self.subTest(name=name, backup_state=backup_state):
                    self.reset_notices_and_state()
                    state = {'failing': {}}
                    if backup_state == 'recovery':
                        state['failing']['backup'] = {'since': 123, 'msg': 'old outage', 'incident_notified': True}
                    Path(hc.STATE).write_text(json.dumps(state))
                    os.environ['LOADED'] = '' if backup_state == 'outage' else self.loaded
                    checks = [('backup', hc.check_backup), (name, lambda: (False, 'fixture ordinary failure'))]
                    with mock.patch.object(hc, 'CHECKS', checks), mock.patch.object(
                            hc, 'notify', return_value=True) as ordinary, self.fail_state_replacement(after_send=False):
                        with self.assertRaises(OSError):
                            hc.main()
                        ordinary.assert_called_once()
                        self.assertIn(name, ordinary.call_args.args[1])
                    self.assertEqual(self.sent(), [])
                    self.assertEqual(json.loads(Path(hc.STATE).read_text()), state)

    def test_state_read_errors_still_allow_ordinary_alert_attempts(self):
        original_open = open
        for name in ('disk', 'sync'):
            for failure in ('permission', 'invalid-json'):
                with self.subTest(name=name, failure=failure):
                    self.reset_notices_and_state()
                    contents = '{}' if failure == 'permission' else '{'
                    Path(hc.STATE).write_text(contents)
                    def read(path, *args, **kwargs):
                        if path == hc.STATE and failure == 'permission':
                            raise PermissionError('fixture state read failed')
                        return original_open(path, *args, **kwargs)
                    checks = [('backup', lambda: (False, 'backup outage')), (name, lambda: (False, 'ordinary failure'))]
                    with mock.patch.object(hc, 'CHECKS', checks), mock.patch.object(
                            hc, 'notify', return_value=True) as ordinary, mock.patch('builtins.open', side_effect=read):
                        with self.assertRaises((PermissionError, json.JSONDecodeError)):
                            hc.main()
                        ordinary.assert_called_once()
                        self.assertIn(name, ordinary.call_args.args[1])
                    self.assertEqual(self.sent(), [])
                    self.assertEqual(Path(hc.STATE).read_text(), contents)

    def test_msgs_recovery_retry_does_not_relatch_the_archive(self):
        notify = hc.notify_backup
        os.environ['LOADED'] = self.loaded + ',com.ardud.message-archive'
        for interrupted in (False, True):
            with self.subTest(backup_send_interrupted=interrupted):
                self.reset_notices_and_state()
                old_pass = time.time() - 7200
                new_pass = time.time() - 60
                seen = self.root / 'msgs_seen.json'
                seen.write_text(json.dumps({'last_ok': old_pass, 'boot': 'fixture', 'start': 0,
                                            'seen': 5000, 'up': 5000, 'carried': 0, 'failed': True}))
                Path(hc.STATE).write_text(json.dumps({'failing': {
                    'msgs': {'since': 123, 'msg': 'archive stopped', 'notified_day': '20261112'}}}))
                def stop_after_send(*args, **kwargs):
                    notify(*args, **kwargs)
                    raise SystemExit('fixture interrupted backup send')
                with mock.patch.object(hc, 'MSGS_SEEN', str(seen)), mock.patch.object(
                        hc, '_msgs_last_ok', return_value=new_pass), mock.patch.object(
                        hc, '_uptime', return_value=5000), mock.patch.object(
                        hc, '_boot_id', return_value='fixture'), mock.patch.object(
                        hc.os.path, 'ismount', return_value=True), mock.patch.object(
                        hc, 'CHECKS', [('backup', lambda: (False, 'outage')), ('msgs', hc.check_msgs)]), mock.patch.object(
                        hc, 'notify', side_effect=[True] if interrupted else [False, True]) as ordinary:
                    if interrupted:
                        with mock.patch.object(hc, 'notify_backup', side_effect=stop_after_send), self.assertRaises(SystemExit):
                            hc.main()
                    else:
                        hc.main()
                        self.assertTrue(json.loads(Path(hc.LAST).read_text())['checks']['msgs']['ok'])
                    self.assertFalse(hc._msgs_failing())
                    hc.main()
                    self.assertTrue(json.loads(Path(hc.LAST).read_text())['checks']['msgs']['ok'])
                    self.assertNotIn('msgs', json.loads(Path(hc.STATE).read_text())['failing'])
                    self.assertEqual(ordinary.call_count, 1 if interrupted else 2)

    def test_failed_summary_write_does_not_resend_acknowledged_alert(self):
        replace = os.replace
        def fail(src, dst):
            if dst == hc.LAST:
                raise OSError('fixture summary replacement failed')
            return replace(src, dst)
        os.environ['LOADED'] = ''
        with mock.patch.object(hc.os, 'replace', side_effect=fail), self.assertRaises(OSError):
            self.tick()
        self.tick()
        self.assertEqual(len(self.sent()), 1)
        self.assertEqual(len(self.delivered()), 1)

    def test_recovery_after_interrupted_alert_acknowledgement(self):
        os.environ['LOADED'] = ''
        with self.fail_state_replacement(after_send=True), self.assertRaises(OSError):
            self.tick()
        os.environ['LOADED'] = self.loaded
        self.tick()
        self.tick()
        self.assertEqual(len(self.delivered()), 2)
        self.assertIn('recovered at', self.delivered()[1][-1])

    def test_failed_recovery_acknowledgement_reuses_persisted_key(self):
        os.environ['LOADED'] = ''
        self.tick()
        os.environ['LOADED'] = self.loaded
        with self.fail_state_replacement(after_send=True), self.assertRaises(OSError):
            self.tick()
        state = json.loads(Path(hc.STATE).read_text())
        self.assertNotIn('backup', state['failing'])
        self.assertEqual(len(state['backup_recoveries']), 1)
        self.tick()
        self.tick()
        self.assertEqual(len(self.sent()), 3)
        self.assertEqual(self.sent()[1], self.sent()[2])
        self.assertEqual(len(self.delivered()), 2)

    def test_unreadable_state_cannot_create_a_new_incident_key(self):
        os.environ['LOADED'] = ''
        os.environ['NOTICE_FAIL'] = '1'
        self.tick()
        incident = json.loads(Path(hc.STATE).read_text())['failing']['backup']['since']
        original_open = open
        def fail(path, *args, **kwargs):
            if path == hc.STATE:
                raise PermissionError('fixture state read failed')
            return original_open(path, *args, **kwargs)
        with mock.patch('builtins.open', side_effect=fail), self.assertRaises(PermissionError):
            self.tick()
        self.assertEqual(len(self.sent()), 1)
        os.environ['NOTICE_FAIL'] = '0'
        self.tick()
        self.assertEqual(len(self.delivered()), 1)
        self.assertTrue(self.sent()[-1][3].endswith(':' + str(incident)))

    def test_dry_run_never_notifies_or_writes(self):
        os.environ['LOADED'] = ''
        with mock.patch.object(sys, 'argv', ['health_check.py', '--dry-run']), mock.patch('builtins.print'):
            self.tick()
        self.assertEqual(self.sent(), [])
        self.assertFalse(Path(hc.STATE).exists())
        self.assertFalse(Path(hc.LAST).exists())

    def test_other_jobs_unloaded_alert_and_recover(self):
        for name, check, label in [('health_backup', hc.check_health_backup, 'health-backup'),
                                   ('person_backup', hc.check_person_backups, 'offbox-person-backup')]:
            with self.subTest(name=name):
                self.notices.write_text('')
                os.environ['LOADED'] = ''
                self.tick(check, name)
                self.tick(check, name)
                self.assertEqual(len(self.sent()), 1)
                self.assertIn(label + ' not loaded', self.sent()[0][-1])
                Path(hc.HEALTH_BACKUP_STATUS).write_text(json.dumps(self.st))
                Path(hc.PERSON_BACKUP_DIR).mkdir(exist_ok=True)
                (Path(hc.PERSON_BACKUP_DIR) / 'moni-backup.json').write_text(json.dumps(self.st))
                os.environ['LOADED'] = self.loaded
                self.tick(check, name)
                self.assertEqual(len(self.sent()), 2)
                self.assertIn('recovered', self.sent()[1][-1])

    def test_nonzero_launchctl_with_stdout_is_not_loaded(self):
        with mock.patch.object(hc.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, 'error', '')):
            self.assertFalse(hc.launchd_exit('fixture')[2])


if __name__ == '__main__':
    unittest.main()

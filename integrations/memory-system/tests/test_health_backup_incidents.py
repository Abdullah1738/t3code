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
        command = self.root / 'notify.py'
        command.write_text("""import json, os, sys
assert 'BUN_INSPECT' not in os.environ
with open(os.environ['NOTICE_LOG'], 'a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\\n')
sys.exit(int(os.environ.get('NOTICE_FAIL', '0')))
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
            'NOTICE_LOG': str(self.notices), 'BUN_INSPECT': 'must-be-removed'}),
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

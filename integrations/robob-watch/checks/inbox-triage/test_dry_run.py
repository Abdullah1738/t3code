"""Replay must leave business state and runner metadata outside WATCH_DIR untouched."""
import ast
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location('triage_dry_test', Path(__file__).with_name('triage.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)


def snapshot(root, scratch):
    result = {}
    for path in root.rglob('*'):
        if path == scratch or scratch in path.parents:
            continue
        stat = path.stat()
        result[str(path.relative_to(root))] = (stat.st_mtime_ns, stat.st_mode,
            hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None)
    return result


class DryRunTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.home = self.root / 'home'
        self.scratch = self.root / 'replay-watch/watchers/scratch'
        self.scratch.mkdir(parents=True)
        with sqlite3.connect(self.scratch.parent.parent / 'relay-lock.sqlite') as relay:
            relay.execute('CREATE TABLE sentinel(value TEXT)')
        self.live = self.home / '.local/share/robob-watch/watchers/inbox-triage'
        self.data = self.home / 'Documents/assistant/inbox-triage'
        self.money = self.root / 'money-cases'
        self.now = time.time()
        self.helper_environments = []
        for directory in (self.live, self.data, self.money, self.home / '.config/opencode'):
            directory.mkdir(parents=True)
        (self.live / 'cursor.json').write_text('{"cursors":{"gmail":{"uid":99}}}')
        (self.live / 'state.json').write_text('{"admitted_run":{"run":"live","attempt":"live-attempt"}}')
        (self.data / 'prefs.md').write_text('Keep useful financial and withdrawal messages.')
        (self.data / 'settings.json').write_text('{}')
        (self.home / '.config/opencode/openrouter-key').write_text('offline-fixture-key')
        (self.money / 'cases.json').write_text('{"version":1,"cases":[],"purchases":[]}')
        (self.money / 'questions.json').write_text('{"version":1,"questions":[]}')
        (self.money / 'cards.json').write_text('{"dead":{"5542":{"note":"cancelled","since":"2026-11-01"}}}')
        (self.money / 'subscriptions.json').write_text('{"version":1,"subscriptions":[]}')
        (self.money / 'owner-texts.json').write_text('{"sentinel":"unchanged"}')
        self.environment = {'HOME': str(self.home), 'WATCH_DIR': str(self.scratch), 'ROBOB_TEST': '1',
                            'MONEY_CASES_DIR': str(self.money),
                            'TOOLLOG_DIR': str(self.home / 'live-watcher-logs'),
                            'ROBOB_TOOL_LOG_DIR': str(self.home / 'live-orders-logs')}
        self.stack.enter_context(patch.dict(os.environ, self.environment))
        for name, value in (('HOME', self.home), ('LIVE', self.live), ('DATA', self.data),
                            ('WATCHERS', self.live.parent), ('PHONE_LOCK', self.home / 'phone-lock'),
                            ('COMMERCE', self.home / '.local/bin/commerce')):
            self.stack.enter_context(patch.object(t, name, value))
        self.mc = t.load_module('dry_money_cases_test', t.MONEY_CASES)
        self.stack.enter_context(patch.object(self.mc, 'DATA', self.money))
        load_module = t.load_module
        self.stack.enter_context(patch.object(t, 'load_module', side_effect=lambda name, path:
            self.mc if Path(path) == t.MONEY_CASES else load_module(name, path)))
        # The money algorithms and their persistence stay real; external source answers are fixtures.
        self.stack.enter_context(patch.object(self.mc, 'explain_charge', return_value={
            'verdict': 'ask', 'why': 'no fixture receipt', 'errors': []}))
        self.stack.enter_context(patch.object(self.mc.charges, 'search', return_value=[]))
        self.stack.enter_context(patch.object(t.subprocess, 'run', side_effect=self.helper))
        self.stack.enter_context(patch.object(t.urllib.request, 'urlopen', side_effect=self.classifier))
        self.stack.enter_context(patch.object(t, 'send_urgent', side_effect=AssertionError('must not send')))

    def item(self, ident, sender, text, **fields):
        return {'id': ident, 'source': 'email', 'sender': sender, 'subject': '',
                'preview': text, 'ts': self.now - 600, **fields}

    def helper(self, command, **kwargs):
        self.helper_environments.append((sys.dont_write_bytecode, dict(os.environ)))
        if command[1:] == ['open-flows', '--minutes', '60']:
            self.mc.toollog.emit('commerce', 'cmd.start', ok=True, props={'subcommand': 'open-flows'})
            return subprocess.CompletedProcess(command, 0, '{"ok":true,"open":[]}', '')
        if command[1:] == ['list', '--open', '--json']:
            return subprocess.CompletedProcess(command, 0, '[]', '')
        self.fail('unexpected subprocess: ' + str(command))

    def classifier(self, request, **kwargs):
        self.assertEqual(request.full_url, 'https://openrouter.ai/api/v1/chat/completions')
        items = json.loads(json.loads(request.data)['messages'][1]['content'])['items']
        content = {'hits': [{'id': item['id'], 'reason': 'fixture review', 'urgency': 'today'} for item in items]}
        return io.StringIO(json.dumps({'choices': [{'message': {'content': json.dumps(content)}}],
                                      'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'cost': 0}}))

    def test_main_replay_only_writes_under_scratch_with_inherited_admission(self):
        items = [self.item('mail:charge', 'EmiratesNBD',
                          'Purchase of EUR 100 with Credit Card ending 1111 at Acme, Amsterdam. Avl Cr. Limit'),
                 self.item('mail:renewal', 'billing@elevenlabs.io',
                          'Your ElevenLabs Pro plan will renew on 21 Nov 2026 for USD 118.80 using card ending in 5542.'),
                 self.item('mail:payment', 'Wio', 'Your autopay of AED 3,532.73 failed; repay before midnight'),
                 self.item('mail:withdrawal', 'Kraken', 'Crypto withdrawal request ' + 'a' * 64)]
        results = {'gmail': {'cursor': {'uid': 123}, 'items': items, 'drops': {}, 'scanned': len(items)}}
        report_path = self.scratch / 'report.json'
        env = {'WATCH_ATTEMPT': 'live-attempt', 'WATCH_RUN': 'live', 'WATCH_PENDING': '1',
               'ROBOB_ADMISSION_PATH': str(self.live / 'state.json'), 'ROBOB_REPLY_PATH': str(self.live / 'reply')}
        # Exercise the real admission wrapper even when this test module was imported outside a runner.
        admission = t.load_module('dry_admission_test', Path(__file__).resolve().parents[2] / 'helpers/watch_admission.py')
        with patch.dict(os.environ, env), patch.object(t, 'atomic', admission.admitted_check(t.atomic)), \
             patch.object(t, 'collect', return_value=(results, {})), \
             patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
             patch.object(sys, 'argv', ['triage.py', '--dry-run-hours', '2', '--report', str(report_path)]), \
             contextlib.redirect_stdout(io.StringIO()):
            before = snapshot(self.root, self.scratch)
            self.assertEqual(t.main(), 0)
            self.assertEqual(snapshot(self.root, self.scratch), before)
            self.assertEqual(os.environ['WATCH_ATTEMPT'], 'live-attempt')
            self.assertEqual(os.environ['ROBOB_REPLY_PATH'], env['ROBOB_REPLY_PATH'])
        self.assertTrue(self.helper_environments)
        for bytecode, environment in self.helper_environments:
            self.assertTrue(bytecode)
            self.assertEqual(environment.get('PYTHONDONTWRITEBYTECODE'), '1')
            self.assertNotIn('WATCH_ATTEMPT', environment)
            self.assertNotIn('ROBOB_ADMISSION_PATH', environment)
        report = json.loads(report_path.read_text())
        self.assertEqual(report['dropped']['renewal_case'], 1)
        self.assertTrue(any(i.get('charge_check') for i in report['candidates']))
        self.assertTrue(any(i.get('payment_notice') for i in report['candidates']))
        self.assertEqual(report['dry_run_notes']['payment_tracking'], 'skipped (dry run; detection only)')
        self.assertEqual(len(self.mc.load(self.scratch / 'scratch-renewals')['cases']), 1)
        self.assertFalse((self.scratch / 'cursor.json').exists())
        self.assertTrue(list((self.scratch / 'diagnostics/tools/watchers').glob('*.ndjson')))
        self.assertTrue(list((self.scratch / 'diagnostics/tools/orders').glob('*.ndjson')))

    def test_unsafe_paths_refuse_before_any_write(self):
        alias = self.root / 'live-alias'
        alias.symlink_to(self.live, target_is_directory=True)
        for wd, report in ((None, None), (self.live, None), (self.live.parent / 'inbox-triage-fastpath', None),
                           (alias, None), (self.scratch, self.live / 'report.json')):
            with self.subTest(wd=wd, report=report), patch.dict(os.environ):
                if wd is None:
                    os.environ.pop('WATCH_DIR', None)
                else:
                    os.environ['WATCH_DIR'] = str(wd)
                args = ['triage.py', '--dry-run-hours', '1'] + (['--report', str(report)] if report else [])
                with patch.object(sys, 'argv', args), patch.object(t, 'run') as run, \
                     contextlib.redirect_stderr(io.StringIO()) as error:
                    before = snapshot(self.root, self.scratch)
                    self.assertEqual(t.main(), 2)
                    self.assertIn('scratch WATCH_DIR', error.getvalue())
                    self.assertEqual(snapshot(self.root, self.scratch), before)
                    run.assert_not_called()

    def test_explicit_scratch_logs_and_environment_restore_after_error(self):
        path = self.scratch / 'custom-logs'
        previous = sys.dont_write_bytecode
        with patch.dict(os.environ, {'TOOLLOG_DIR': str(path), 'WATCH_ATTEMPT': 'live'}):
            with self.assertRaisesRegex(RuntimeError, 'fixture'):
                with t.dry_environment(types.SimpleNamespace(dry_run_hours=1, report=None)):
                    self.assertEqual(Path(os.environ['TOOLLOG_DIR']), path.resolve())
                    t.log_failure('fixture.failure')
                    raise RuntimeError('fixture')
            self.assertEqual(os.environ['WATCH_ATTEMPT'], 'live')
            self.assertEqual(sys.dont_write_bytecode, previous)
        self.assertTrue(list(path.glob('*.ndjson')))

    def test_reused_scratch_rejects_directory_symlink_file_symlink_and_hardlink(self):
        books = self.scratch / 'scratch-renewals'
        for shape in ('symlink directory', 'symlink file', 'hardlink'):
            with self.subTest(shape=shape):
                if shape == 'symlink directory':
                    books.symlink_to(self.money, target_is_directory=True)
                    alias = books
                else:
                    books.mkdir()
                    alias = books / 'cases.json'
                    if shape == 'symlink file':
                        alias.symlink_to(self.money / 'cases.json')
                    else:
                        os.link(self.money / 'cases.json', alias)
                before = snapshot(self.root, self.scratch)
                with patch.object(sys, 'argv', ['triage.py', '--dry-run-hours', '1']), \
                     patch.object(t, 'collect') as collect, contextlib.redirect_stderr(io.StringIO()) as error:
                    self.assertEqual(t.main(), 2)
                self.assertIn('dry run refused: scratch destination', error.getvalue())
                collect.assert_not_called()
                with self.assertRaisesRegex(ValueError, 'scratch destination'):
                    t.money_books(self.scratch, self.mc, dry=True)
                self.assertEqual(snapshot(self.root, self.scratch), before)
                alias.unlink()
                if books.exists():
                    books.rmdir()

    def test_main_chat_followup_does_not_create_sqlite_sidecars(self):
        messages = self.home / 'Library/Messages/chat.db'
        messages.parent.mkdir(parents=True)
        with contextlib.closing(sqlite3.connect(messages)) as writer:
            writer.execute('PRAGMA journal_mode=WAL')
            writer.executescript('''
                CREATE TABLE handle(id TEXT);
                CREATE TABLE message(guid TEXT, date INTEGER, is_from_me INTEGER, is_sent INTEGER, error INTEGER,
                                     date_retracted INTEGER, associated_message_type INTEGER,
                                     thread_originator_guid TEXT, associated_message_guid TEXT, handle_id INTEGER);
                CREATE TABLE chat(style INTEGER);
                CREATE TABLE chat_message_join(chat_id INTEGER, message_id INTEGER, message_date INTEGER);
                CREATE TABLE chat_handle_join(chat_id INTEGER, handle_id INTEGER);
                INSERT INTO handle VALUES('fixture-support');
                INSERT INTO message VALUES('fixture-guid',100,0,1,0,0,0,NULL,NULL,1);
                INSERT INTO chat VALUES(45);
                INSERT INTO chat_message_join VALUES(1,1,100);
                INSERT INTO chat_handle_join VALUES(1,1);
            ''')
            writer.commit()
            writer.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchall()
        # macOS SQLite can retain empty sidecars after close; model a quiescent store without them.
        for suffix in ('-wal', '-shm'):
            Path(str(messages) + suffix).unlink(missing_ok=True)
        self.assertFalse(Path(str(messages) + '-wal').exists())
        candidate = self.item('imsg:1', 'fixture-support', 'Please review this issue', source='imessage')
        results = {'fixture': {'cursor': 1, 'items': [candidate], 'drops': {}, 'scanned': 1}}
        with patch.object(t, 'collect', return_value=(results, {})), \
             patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
             patch.object(sys, 'argv', ['triage.py', '--dry-run-hours', '1']), \
             contextlib.redirect_stdout(io.StringIO()):
            before = snapshot(self.root, self.scratch)
            self.assertEqual(t.main(), 0)
            self.assertEqual(snapshot(self.root, self.scratch), before)
        self.assertFalse(Path(str(messages) + '-shm').exists())

    def test_unreadable_scratch_directories_refuse_before_logger_or_book_access(self):
        for shape in ('root', 'logs', 'scratch-renewals', 'scratch-renewals/nested'):
            with self.subTest(shape=shape):
                wd = self.scratch / shape.replace('/', '-')
                wd.mkdir()
                blocked = wd if shape == 'root' else wd / shape
                blocked.mkdir(parents=True, exist_ok=True)
                outside = self.root / ('sentinel-' + shape.replace('/', '-'))
                outside.write_bytes(b'unchanged fixture\n')
                outside.chmod(0o644)
                day = t.dt.datetime.now(t.UTC).date().isoformat()
                os.link(outside, blocked / (day + '.ndjson' if shape == 'logs' else 'cases.json'))
                before = (outside.read_bytes(), outside.stat().st_mode, outside.stat().st_mtime_ns)
                blocked.chmod(0o333)
                original_iterdir = Path.iterdir
                def iterdir(path):
                    # Root on Linux can read 0333; reproduce the same EACCES as the live user.
                    if path == blocked:
                        raise PermissionError('fixture directory cannot be listed')
                    return original_iterdir(path)
                report = wd / 'report.json'
                try:
                    with patch.object(Path, 'iterdir', iterdir), \
                         patch.dict(os.environ, {'WATCH_DIR': str(wd), 'TOOLLOG_DIR': str(wd / 'logs')}), \
                         patch.object(t, 'collect') as collect, \
                         patch.object(sys, 'argv', ['triage.py', '--dry-run-hours', '1', '--report', str(report)]), \
                         contextlib.redirect_stderr(io.StringIO()) as error:
                        self.assertEqual(t.main(), 2)
                        self.assertIn('cannot inspect scratch directory (PermissionError)', error.getvalue())
                        collect.assert_not_called()
                        if shape.startswith('scratch-renewals'):
                            with self.assertRaisesRegex(ValueError, 'cannot inspect scratch directory'):
                                t.money_books(wd, self.mc, dry=True)
                    self.assertFalse(report.exists())
                    self.assertEqual((outside.read_bytes(), outside.stat().st_mode, outside.stat().st_mtime_ns), before)
                    self.assertEqual(blocked.stat().st_mode & 0o777, 0o333)
                finally:
                    blocked.chmod(0o700)

    def test_expired_mail_is_a_source_error_in_the_report(self):
        mail = DryMailTests().mail()
        response = subprocess.CompletedProcess([], 0, json.dumps({
            'access_token': 'synthetic-fixture', 'issued_at': 1, 'expires_in': 3600}), '')
        empty = {'cursor': 0, 'items': [], 'drops': {}, 'scanned': 0}
        report = self.scratch / 'expired.json'
        with patch.object(t, 'ACCOUNTS', ('gmail',)), \
             patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
             patch.object(t, 'run_mail', side_effect=lambda *_: t.dry_mail_connect(mail, 'gmail', 7)), \
             patch.object(t.subprocess, 'run', return_value=response), \
             patch.object(t, 'collect_whatsapp', return_value=empty), patch.object(t, 'collect_imessage', return_value=empty), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(t.run(types.SimpleNamespace(dry_run_hours=1, report=str(report))), 1)
        self.assertIn('mail: skipped (dry run, cached token expired)', json.loads(report.read_text())['source_errors']['gmail'])
        mail.connect.assert_not_called()

    def test_cached_mail_failures_never_refresh_or_write_outside_scratch(self):
        for fast in (False, True):
            for failure in ('expired', 'missing', 'rejected'):
                with self.subTest(fast=fast, failure=failure):
                    mail = DryMailTests().mail()
                    mail.imaplib.IMAP4_SSL.return_value.authenticate.side_effect = t.imaplib.IMAP4.error('private rejection')
                    blob = {'access_token': 'synthetic-fixture', 'issued_at': self.now, 'expires_in': 3600}
                    if failure == 'expired':
                        blob['issued_at'] = 1
                    elif failure == 'missing':
                        blob = {}
                    calls = []
                    base_load = t.load_module
                    def load(name, path):
                        return mail if Path(path) == self.home / '.local/bin/mailsearch' else base_load(name, path)
                    def process(command, **kwargs):
                        calls.append(command)
                        if command[0] == mail.KC_READ:
                            return subprocess.CompletedProcess(command, 0, json.dumps(blob), '')
                        if '--mail-credentials' in command:
                            self.assertNotIn('--refresh-mail-credentials', command)
                            env = kwargs['env']
                            self.assertEqual(env['PYTHONDONTWRITEBYTECODE'], '1')
                            self.assertEqual(env['INBOX_TRIAGE_DRY_RUN'], '1')
                            self.assertIn(self.scratch.resolve(), Path(env['TOOLLOG_DIR']).resolve().parents)
                            self.assertNotIn('ROBOB_ADMISSION_PATH', env)
                            with patch.dict(os.environ, env):
                                try:
                                    credential = t.mail_credentials('gmail')
                                    return subprocess.CompletedProcess(command, 0, credential, '')
                                except Exception as error:
                                    return subprocess.CompletedProcess(command, 1, '', str(error))
                        if '--mail-worker' in command:
                            request = json.loads(kwargs['input'])
                            self.assertEqual(Path(request['progress_path']).resolve(), self.scratch.resolve() / 'mail-progress-gmail.json')
                            try:
                                result = t.mail_worker('gmail', request)
                                return subprocess.CompletedProcess(command, 0, json.dumps(result), '')
                            except Exception as error:
                                return subprocess.CompletedProcess(command, 1, '', f'{type(error).__name__}: {error}')
                        return self.helper(command, **kwargs)
                    empty = {'cursor': 0, 'items': [], 'drops': {}, 'scanned': 0}
                    report = self.scratch / 'cached-mail.json'
                    args = ['triage.py', '--dry-run-hours', '1', '--report', str(report)]
                    if fast:
                        args.append('--fast-only')
                    with patch.object(t, 'ACCOUNTS', ('gmail',)), patch.object(t, 'load_module', side_effect=load), \
                         patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
                         patch.object(t.subprocess, 'run', side_effect=process), \
                         patch.object(t.subprocess, 'Popen', side_effect=AssertionError('must not launch refresh')) as detached, \
                         patch.object(t, 'collect_whatsapp', return_value=empty), patch.object(t, 'collect_imessage', return_value=empty), \
                         patch.object(sys, 'argv', args), contextlib.redirect_stdout(io.StringIO()):
                        before = snapshot(self.root, self.scratch)
                        self.assertEqual(t.main(), 0 if fast else 1)
                        self.assertEqual(snapshot(self.root, self.scratch), before)
                    if not fast:
                        message = {'expired': 'cached token expired', 'missing': 'cached credential unavailable',
                                   'rejected': 'cached credential rejected'}[failure]
                        self.assertIn(message, json.loads(report.read_text())['source_errors']['gmail'])
                    detached.assert_not_called()
                    mail.connect.assert_not_called()
                    self.assertEqual(sum('--mail-credentials' in c for c in calls), 1)
                    self.assertFalse(any('--refresh-mail-credentials' in c for c in calls))
                    self.assertFalse((self.scratch / 'credential-gmail.lock').exists())

    def test_dry_parent_refuses_auth_refresh_signal_and_overrides_progress_path(self):
        for fast in (False, True):
            with self.subTest(fast=fast), t.dry_environment(types.SimpleNamespace(dry_run_hours=1, report=None)), \
                 patch.object(t, 'prepare_mail_credentials', return_value='fixture') as credentials, \
                 patch.object(t, 'run_mail_fetch', side_effect=t.MailAuthRejected('fixture')) as fetch:
                before = snapshot(self.root, self.scratch)
                with self.assertRaisesRegex(RuntimeError, 'cached credential rejected') as caught:
                    t.run_mail('gmail', {'since': self.now - 3600, 'now': self.now, 'fast': fast,
                                        'progress_path': str(self.live / 'mail-progress-gmail.json')})
                self.assertEqual(snapshot(self.root, self.scratch), before)
                self.assertEqual(credentials.call_count, 1)
                self.assertFalse(credentials.call_args.kwargs['refresh'])
                self.assertTrue(credentials.call_args.kwargs['dry'])
                self.assertEqual(fetch.call_args.args[1]['progress_path'], str(self.scratch.resolve() / 'mail-progress-gmail.json'))
                self.assertEqual(caught.exception.mail_progress['credential_refresh_attempts'], 0)

    def test_live_money_entry_points_keep_default_live_books(self):
        charge = self.item('mail:charge', 'EmiratesNBD',
                           'Purchase of EUR 100 with Credit Card ending 1111 at Acme, Amsterdam. Avl Cr. Limit')
        payment = self.item('mail:payment', 'Wio', 'Your autopay of AED 3,532.73 failed; repay before midnight')
        renewal = self.item('mail:renewal', 'billing@elevenlabs.io',
                           'Your ElevenLabs Pro plan will renew on 21 Nov 2026 for USD 118.80 using card ending in 5542.')
        with patch.object(self.mc, 'screen', return_value=None) as screen, \
             patch.object(self.mc, 'record_payment') as record, patch.object(self.mc, 'renewal_case') as renew:
            t.charge_checks([charge], self.now, False, wd=self.live)
            t.payment_checks([payment], self.now, False, wd=self.live)
            t.renewal_checks([renewal], self.now, False, wd=self.live)
        self.assertIsNone(screen.call_args.kwargs['data'])
        self.assertTrue(screen.call_args.kwargs['record'])
        self.assertIsNone(record.call_args.args[0])
        self.assertIsNone(renew.call_args.args[0])


class DrySQLiteTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.scratch = self.root / 'scratch'
        self.scratch.mkdir()
        self.stack.enter_context(patch.dict(os.environ, {'HOME': str(self.root), 'ROBOB_TEST': '1',
            'INBOX_TRIAGE_DRY_RUN': '1', 'PYTHONDONTWRITEBYTECODE': '1',
            'TOOLLOG_DIR': str(self.scratch / 'logs'), 'ROBOB_TOOL_LOG_DIR': str(self.scratch / 'logs')}))

    def database(self, path, wal, schema):
        writer = sqlite3.connect(path)
        self.stack.callback(writer.close)
        writer.execute('PRAGMA journal_mode=WAL')
        writer.executescript(schema)
        writer.commit()
        if not wal:
            writer.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchall()
            writer.close()
            for suffix in ('-wal', '-shm'):
                Path(str(path) + suffix).unlink(missing_ok=True)
        return writer

    def unchanged(self):
        # Existing WAL readers can update reader marks; database and WAL bytes may never change.
        return {name: value for name, value in snapshot(self.root, self.scratch).items()
                if not name.endswith('-shm')}

    def test_chat_and_bridge_readers_preserve_bytes_with_and_without_live_wal(self):
        for wal in (False, True):
            with self.subTest(wal=wal):
                path = self.root / ('wal ?.db' if wal else 'closed ?.db')
                writer = self.database(path, wal, '''CREATE TABLE kv(key TEXT, value TEXT);
                    INSERT INTO kv VALUES('route', '{"id":"fixture-owner"}');
                    CREATE TABLE outbox(id TEXT, state TEXT, attempts INTEGER, providerId TEXT);
                    CREATE TABLE whatsmeow_lid_map(pn TEXT, lid TEXT);
                    INSERT INTO whatsmeow_lid_map VALUES('1','99');
                    CREATE TABLE contacts(jid TEXT, full_name TEXT, business_name TEXT, system_name TEXT, push_name TEXT);
                    CREATE TABLE contact_aliases(jid TEXT, alias TEXT);
                    CREATE TABLE whatsmeow_contacts(their_jid TEXT, full_name TEXT, business_name TEXT, push_name TEXT);
                    INSERT INTO whatsmeow_contacts VALUES('1@s.whatsapp.net','Fixture contact',NULL,NULL);''')
                if wal:
                    # This value lives in the WAL, so immutable reads would miss it.
                    writer.execute("UPDATE kv SET value='{\"id\":\"wal-owner\"}'")
                    writer.commit()
                self.assertEqual(Path(str(path) + '-wal').exists(), wal)
                before, names = self.unchanged(), set(self.root.rglob('*'))
                with patch.object(t, 'BRIDGE_DB', path):
                    self.assertEqual(t.owner_route(), 'wal-owner' if wal else 'fixture-owner')
                    self.assertIsNone(t.imessage_status('not-delivered'))
                    with contextlib.closing(t.db(path)) as reader:
                        self.assertEqual(reader.execute('SELECT COUNT(*) FROM kv').fetchone()[0], 1)
                        helpers = Path(__file__).resolve().parents[2] / 'helpers'
                        with patch.object(t, 'HELPERS', helpers):
                            wa = t.whatsapp_helper()
                        wa.SESSION_DB = str(path)
                        self.assertEqual(wa.resolve(reader, '1@s.whatsapp.net'), ['1@s.whatsapp.net', '99@lid'])
                        self.assertEqual(wa.name_of(reader, '1@s.whatsapp.net'), 'Fixture contact')
                self.assertEqual(self.unchanged(), before)
                self.assertEqual(set(self.root.rglob('*')), names)
                self.assertEqual(Path(str(path) + '-shm').exists(), wal)

    def test_archive_search_and_show_use_same_boundary_in_isolated_worker(self):
        archive_source = Path(__file__).resolve().parents[3] / 'message-archive/src'
        tree = ast.parse((archive_source / 'store.py').read_text())
        schema = next(ast.literal_eval(node.value) for node in tree.body
                      if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'SCHEMA'
                                                             for target in node.targets))
        mc = t.load_module('dry_archive_cases_test', t.MONEY_CASES)
        original = mc.charges.msgs
        for wal in (False, True):
            with self.subTest(wal=wal):
                archive = self.root / ('archive-wal' if wal else 'archive-closed')
                archive.mkdir()
                writer = sqlite3.connect(archive / 'index.db')
                self.stack.callback(writer.close)
                writer.execute('PRAGMA journal_mode=WAL')
                writer.executescript(schema)
                writer.execute("INSERT INTO items(source,account,ext_id,ts,subject,body,updated_at) "
                               "VALUES('email','gmail','fixture',1000,'Fixture withdrawal','Offline fixture',1000)")
                writer.commit()
                if not wal:
                    writer.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchall()
                    writer.close()
                    for suffix in ('-wal', '-shm'):
                        Path(str(archive / 'index.db') + suffix).unlink(missing_ok=True)
                before = self.unchanged()
                names = {p for p in self.root.rglob('*') if p != self.scratch and self.scratch not in p.parents}
                with patch.dict(os.environ, {'MSGS_ROOT': str(archive)}), t.archive_reads(mc, dry=True):
                    rows = mc.charges.search('withdrawal', '1970-01-01', source='email')
                    self.assertEqual(len(rows), 1)
                    self.assertIn('Offline fixture', mc.charges.show(rows[0]))
                self.assertIs(mc.charges.msgs, original)
                self.assertEqual(self.unchanged(), before)
                self.assertEqual({p for p in self.root.rglob('*') if p != self.scratch and self.scratch not in p.parents}, names)

    def test_wal_without_shared_memory_refuses_instead_of_creating_it(self):
        path = self.root / 'missing-shm.db'
        path.write_bytes(b'fixture')
        Path(str(path) + '-wal').write_bytes(b'fixture')
        before = self.unchanged()
        with self.assertRaisesRegex(ValueError, 'WAL has no existing shared-memory'):
            t.sqlite_reader(path)
        self.assertEqual(self.unchanged(), before)
        self.assertFalse(Path(str(path) + '-shm').exists())


class DryMailTests(unittest.TestCase):
    def mail(self):
        return types.SimpleNamespace(ACCOUNTS={'gmail': {'host': 'imap.test', 'user': 'fixture@test', 'auth': 'google'},
                                               'icloud': {'auth': 'icloud'}}, KC_READ='fixture-kc-read',
                                     imaplib=types.SimpleNamespace(IMAP4_SSL=Mock()), connect=Mock())

    def test_valid_cached_credential_never_uses_normal_oauth_connection(self):
        mail = self.mail()
        response = subprocess.CompletedProcess([], 0, json.dumps({
            'access_token': 'synthetic-fixture', 'issued_at': time.time(), 'expires_in': 3600}), '')
        with patch.object(t.subprocess, 'run', return_value=response) as read:
            self.assertIs(t.dry_mail_connect(mail, 'gmail', 7), mail.imaplib.IMAP4_SSL.return_value)
        self.assertEqual(read.call_args.args[0], ['fixture-kc-read', 'ortie-gmail'])
        mail.connect.assert_not_called()
        mail.imaplib.IMAP4_SSL.return_value.authenticate.assert_called_once()

    def test_expired_missing_and_rejected_credentials_are_explicit(self):
        for blob, message in (({'issued_at': 1, 'expires_in': 3600, 'access_token': 'synthetic'}, 'cached token expired'),
                              ([], 'cached credential unavailable'), (None, 'cached credential unavailable'),
                              ({}, 'cached credential unavailable')):
            with self.subTest(blob=blob):
                mail = self.mail()
                response = subprocess.CompletedProcess([], 0, json.dumps(blob), '')
                with patch.object(t.subprocess, 'run', return_value=response), \
                     self.assertRaisesRegex(RuntimeError, message):
                    t.dry_mail_connect(mail, 'gmail', 7)
                mail.connect.assert_not_called()
                mail.imaplib.IMAP4_SSL.assert_not_called()

    def test_cached_credential_entrypoint_refuses_explicit_refresh(self):
        mail = self.mail()
        with patch.dict(os.environ, {'INBOX_TRIAGE_DRY_RUN': '1'}), \
             patch.object(t, 'load_module', return_value=mail), \
             patch.object(t.subprocess, 'run') as read, patch.object(t.subprocess, 'Popen') as detached:
            for entry in (lambda: t.mail_credentials('gmail', refresh=True),
                          lambda: t.prepare_mail_credentials('gmail', 7, refresh=True)):
                with self.assertRaisesRegex(RuntimeError, 'credential refresh disabled'):
                    entry()
            read.assert_not_called()
            detached.assert_not_called()

    def test_icloud_still_uses_only_its_read_only_password_path(self):
        mail = self.mail()
        self.assertIs(t.dry_mail_connect(mail, 'icloud', 7), mail.connect.return_value)
        mail.connect.assert_called_once_with('icloud', 7)

    def test_rejected_cached_auth_closes_without_refresh_or_raw_error(self):
        mail = self.mail()
        connection = mail.imaplib.IMAP4_SSL.return_value
        connection.authenticate.side_effect = RuntimeError('synthetic-private-error')
        response = subprocess.CompletedProcess([], 0, json.dumps({
            'access_token': 'synthetic-fixture', 'issued_at': time.time(), 'expires_in': 3600}), '')
        with patch.object(t.subprocess, 'run', return_value=response), \
             self.assertRaisesRegex(RuntimeError, 'cached credential rejected') as raised:
            t.dry_mail_connect(mail, 'gmail', 7)
        self.assertNotIn('synthetic', str(raised.exception))
        connection.shutdown.assert_called_once()
        mail.connect.assert_not_called()

    def test_worker_selects_read_only_auth_only_for_replay(self):
        request = {'credential': 'synthetic-fixture', 'now': time.time(), 'since': 1, 'initialized_at': 1, 'baseline': True}
        connection = Mock()
        connection.select.return_value = ('OK', [])
        connection.response.side_effect = lambda key: (key, [b'2' if key == 'UIDVALIDITY' else b'3'])
        connection.uid.return_value = ('OK', [b''])
        mail = self.mail()
        mail.mail_oauth = types.SimpleNamespace(imaplib=types.SimpleNamespace(IMAP4_SSL=Mock()), _PinnedIMAP=Mock())
        mail.connect.return_value = connection
        with patch.object(t, 'load_module', return_value=mail), \
             patch.object(t, 'dry_mail_connect', return_value=connection) as dry_connect:
            self.assertEqual(t.mail_worker('gmail', request)['scanned'], 0)
            dry_connect.assert_called_once_with(mail, 'gmail', 7, 'synthetic-fixture')
            mail.connect.assert_not_called()
            dry_connect.reset_mock()
            t.mail_worker('gmail', {**request, 'since': None})
            dry_connect.assert_not_called()
            mail.connect.assert_called_once_with('gmail', 7)


class DryBytecodeTests(unittest.TestCase):
    def test_cli_disables_bytecode_before_importing_helpers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            check = root / 'checks/inbox-triage'
            helpers = root / 'helpers'
            check.mkdir(parents=True)
            helpers.mkdir()
            for name in ('triage.py', 'fastpath.py', 'expected_auth.py'):
                shutil.copyfile(Path(__file__).with_name(name), check / name)
            for name in ('redact.py', 'toollog.py'):
                shutil.copyfile(Path(__file__).resolve().parents[2] / 'helpers' / name, helpers / name)
            # argparse accepts every unique prefix, with either '=' or a separate value.
            for end in range(len('--dry-r'), len('--dry-run-hours') + 1):
                option = '--dry-run-hours'[:end]
                for args in ([option + '=1'], [option, '1']):
                    with self.subTest(args=args):
                        env = {k: v for k, v in os.environ.items() if k not in ('WATCH_DIR', 'PYTHONDONTWRITEBYTECODE')}
                        env['HOME'] = str(root / 'home')
                        # Apple's Python disables bytecode by default; force the ordinary CPython setting.
                        launcher = ('import runpy,sys; sys.dont_write_bytecode=False; sys.argv=sys.argv[1:]; '
                                    'runpy.run_path(sys.argv[0],run_name="__main__")')
                        result = subprocess.run([sys.executable, '-I', '-B', '-c', launcher,
                                                 str(check / 'triage.py'), *args],
                                                env=env, capture_output=True, text=True, timeout=3)
                        self.assertEqual(result.returncode, 2, result.stderr)
                        self.assertIn('explicit scratch WATCH_DIR', result.stderr)
                        self.assertEqual(list(root.rglob('*.pyc')), [])


if __name__ == '__main__':
    unittest.main()

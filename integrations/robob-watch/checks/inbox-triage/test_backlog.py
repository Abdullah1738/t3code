"""Offline cursor, credential-isolation and classifier budget regressions."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import concurrent.futures
import contextlib
import copy
import importlib.util
import imaplib
import json
from pathlib import Path
import signal
import ssl
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('triage_backlog', Path(__file__).with_name('triage.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)


class BacklogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'WATCH_DIR': str(self.root), 'ROBOB_TEST': '1',
                                          'TOOLLOG_DIR': str(self.root / 'logs')})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.request = {'credential': 'fixture-secret', 'now': 2000, 'initialized_at': 1000,
                        'cursor': {'validity': 1, 'uid': 0}, 'rules': [], 'seen': []}
        self.imap = types.SimpleNamespace(
            select=lambda *a, **k: ('OK', [b'100']),
            response=lambda key: (key, [b'1' if key == 'UIDVALIDITY' else b'101']),
            uid=self.search, shutdown=lambda: None)
        self.mail = types.SimpleNamespace(connect=lambda *a: self.imap,
            mail_oauth=types.SimpleNamespace(imaplib=types.SimpleNamespace(
                IMAP4=imaplib.IMAP4, IMAP4_SSL=lambda *a, **k: self.imap),
                _PinnedIMAP=lambda *a: self.imap))
        self.fetches = []

    def search(self, command, *args):
        low = int(args[1].split(':')[0]) if args[0] == 'UID' else 1
        return 'OK', [' '.join(map(str, range(low, 101))).encode()]

    def fetch(self, imap, uids, fields):
        self.fetches.append(list(uids))
        return [(uid, '', b'') for uid in uids]

    def record(self, imap, mail, account, validity, record, *args):
        uid = record[0]
        return {'id': f'mail:{account}:{validity}:{uid}', 'uid': uid}, None

    def worker(self, request):
        with patch.object(t, 'load_module', return_value=self.mail), \
             patch.object(t, 'fetch_verified', side_effect=self.fetch), \
             patch.object(t, 'mail_record', side_effect=self.record):
            return t.mail_worker('gmail', request)

    def test_backlog_larger_than_chunk_and_run_limit_catches_up_without_gaps(self):
        seen = []
        request = copy.deepcopy(self.request)
        for _ in range(4):
            result = self.worker(request)
            seen += [item['uid'] for item in result['items']]
            request['cursor'] = result['cursor']
        self.assertEqual(seen, list(range(1, 101)))
        self.assertEqual(request['cursor']['uid'], 100)
        self.assertTrue(all(len(chunk) <= t.MAIL_CHUNK for chunk in self.fetches))

    def test_timeout_mid_chunk_recovers_earlier_durable_chunks(self):
        request = {**self.request, 'progress_path': str(self.root / 'mail-progress-gmail.json')}
        def record(*args):
            if args[4][0] == t.MAIL_CHUNK + 2:
                # Simulate SIGKILL, bypassing normal exception cleanup/checkpointing.
                raise KeyboardInterrupt()
            return self.record(*args)
        with patch.object(t, 'load_module', return_value=self.mail), \
             patch.object(t, 'fetch_verified', side_effect=self.fetch), \
             patch.object(t, 'mail_record', side_effect=record):
            with self.assertRaises(KeyboardInterrupt):
                t.mail_worker('gmail', request)
        with patch.object(t, 'prepare_mail_credentials') as credentials:
            recovered = t.run_mail('gmail', self.request)
        credentials.assert_not_called()
        self.assertEqual(recovered['cursor']['uid'], t.MAIL_CHUNK)
        self.assertEqual([i['uid'] for i in recovered['items']], list(range(1, t.MAIL_CHUNK + 1)))
        # Replaying the uncommitted spool is idempotent; no unlink before main cursor commit.
        self.assertEqual(t.run_mail('gmail', self.request)['cursor'], recovered['cursor'])
        request = {**self.request, 'cursor': recovered['cursor']}
        next_result = self.worker(request)
        self.assertEqual(next_result['items'][0]['uid'], t.MAIL_CHUNK + 1)
        self.assertNotIn('fixture-secret', (self.root / 'mail-progress-gmail.json').read_text())

    def test_fetch_timeout_uses_checkpoint_and_logs_stage(self):
        result = {'items': [{'id': 'x'}], 'cursor': {'validity': 1, 'uid': 8},
                  'drops': {}, 'scanned': 8}
        def fetch(account, request, **kwargs):
            t.atomic(Path(request['progress_path']), {'cursor_before': self.request['cursor'],
                     'stage': 'fetch', 'connect_ms': 17, 'result': result})
            raise subprocess.TimeoutExpired(['worker'], 12)
        with patch.object(t, 'prepare_mail_credentials', return_value='fixture-secret'), \
             patch.object(t, 'run_mail_fetch', side_effect=fetch):
            got = t.run_mail('gmail', self.request)
        self.assertEqual(got['cursor']['uid'], 8)
        self.assertTrue(got['mail_progress']['timed_out'])
        self.assertEqual(got['mail_progress']['stage'], 'fetch')
        self.assertEqual(got['mail_progress']['account'], 'gmail')

    def test_credential_failure_does_not_start_fetch_and_has_separate_logging(self):
        with patch.object(t, 'prepare_mail_credentials', side_effect=TimeoutError), \
             patch.object(t, 'run_mail_fetch') as fetch:
            with self.assertRaises(TimeoutError) as caught:
                t.run_mail('gmail', self.request)
        fetch.assert_not_called()
        info = caught.exception.mail_progress
        self.assertEqual(info['stage'], 'credential')
        self.assertIn('TimeoutError', info['credential_error'])
        self.assertEqual(info['cursor_after'], self.request['cursor'])
        self.assertIn('credential_ms', info)

    def test_fetch_worker_cannot_refresh_or_look_up_credentials(self):
        def connect(*args):
            self.assertEqual(self.mail.mail_oauth.get_token('gmail'), 'fixture-secret')
            with self.assertRaises(t.MailAuthRejected):
                self.mail.mail_oauth.refresh('gmail', force=True)
            return self.imap
        self.mail.connect = connect
        self.worker(self.request)

    def test_deferred_queue_and_spool_survive_a_mid_write_kill(self):
        item = {'id': 'mail:gmail:1:1'}
        t.defer_classifier_items([item], 1000)
        state = {'cursors': {'gmail': {'validity': 1, 'uid': 1}}, 'queue': [item]}
        for name in ('cursor.json', 'mail-progress-gmail.json'):
            path = self.root / name
            t.atomic(path, state)
            changed = copy.deepcopy(state)
            changed['queue'][0]['classifier_deferred_runs'] = 2
            with patch.object(t.os, 'replace', side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    t.atomic(path, changed)
            self.assertEqual(t.read_json(path), state)
            self.assertEqual(t.read_json(path)['queue'][0]['classifier_deferred_at'], 1000)
            t.atomic(path, changed)
            self.assertEqual(t.read_json(path), changed)

    def test_three_starved_runs_persist_then_emit_manual_review(self):
        item = {'id': 'mail:gmail:1:1', 'source': 'email', 'sender': 'person@example.invalid',
                'subject': 'Status update', 'preview': 'Your booking has changed', 'ts': 1000}
        queue = [item, {**item, 'id': 'mail:gmail:1:2'}]
        t.atomic(self.root / 'cursor.json', {'version': 1, 'initialized_at': 1000,
                                           'cursors': {}, 'queue': queue})
        result = {'gmail': {'cursor': {'validity': 1, 'uid': 1}, 'items': [], 'drops': {}, 'scanned': 0}}
        for run in range(3):
            start = 1000 + run * 300
            clock = iter([start])
            def now():
                return next(clock, start + t.CLASSIFY_BY - 3)
            with patch.object(t, 'MAX_BATCH', 1), \
                 patch.object(t, 'active_watchers', return_value=[]), \
                 patch.object(t, 'LIVE', self.root / 'live'), \
                 patch.object(t, 'noise_rules', return_value=[]), \
                 patch.object(t, 'collect', return_value=(copy.deepcopy(result), {})), \
                 patch.object(t, 'build_context', return_value={}), \
                 patch.object(t, 'payment_checks', return_value=({}, None)), \
                 patch.object(t, 'renewal_checks', return_value=({}, None)), \
                 patch.object(t, 'charge_checks', return_value=({}, set(), None)), \
                 patch.object(t, 'handled', return_value=({}, {})), \
                 patch.object(t, 'withdrawal_statuses'), patch.object(t, 'urgent_alerts', return_value={}), \
                 patch.object(t, 'classify') as classifier, \
                 patch.object(t.time, 'time', side_effect=now), patch('builtins.print'):
                self.assertEqual(t.run(types.SimpleNamespace(dry_run_hours=None, report=None)), 0)
            classifier.assert_not_called()
            state = t.read_json(self.root / 'cursor.json')
            log = json.loads((self.root / 'diagnostics/runs.jsonl').read_text().splitlines()[-1])
            if run < 2:
                self.assertNotIn('outbox', state)
                self.assertEqual(state['queue'][0]['classifier_deferred_runs'], run + 1)
                self.assertEqual(state['queue'][1]['classifier_deferred_runs'], run + 1)
                self.assertEqual(log['deferred_count'], 2)
                self.assertEqual(log['oldest_deferred_age_s'], run * 300)
            else:
                self.assertEqual(state['queue'], [])
                self.assertEqual(log['deferred_count'], 0)
                batch = t.read_json(Path(state['outbox']['batch']))
                self.assertEqual(batch['hits'][0]['reason'], 'Classifier unavailable; manually review')
                self.assertEqual({hit['id'] for hit in batch['hits']}, {i['id'] for i in queue})

    def test_test_mode_credential_entrypoint_never_reads_credentials(self):
        result = subprocess.run([sys.executable, '-I', str(Path(t.__file__)),
                                 '--mail-credentials', 'gmail'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 75)
        self.assertEqual(result.stdout, '')

    def test_slow_credential_read_has_no_nested_kill_timeout(self):
        def get_token(account, timeout=30):
            if timeout is not None:
                raise subprocess.TimeoutExpired(['mock-refresh'], timeout)
            return 'fixture-secret'
        self.mail.mail_oauth.get_token = get_token
        with patch.object(t, 'load_module', return_value=self.mail):
            self.assertEqual(t.mail_credentials('gmail'), 'fixture-secret')

    def test_selected_chat_hit_cannot_starve_behind_a_full_classifier_batch(self):
        saved = {'id': 'saved', 'source': 'email', 'sender': 'person@example.invalid',
                 'subject': 'Status update', 'preview': 'Booking changed', 'ts': 1000,
                 'chat_deferred': True, 'reason': 'Review booking', 'urgency': 'today'}
        fresh = [{**saved, 'id': str(n)} for n in range(t.MAX_BATCH)]
        for item in fresh:
            item.pop('chat_deferred')
        t.atomic(self.root / 'cursor.json', {'version': 1, 'initialized_at': 1000,
                                           'cursors': {}, 'queue': [saved, *fresh]})
        result = {'gmail': {'cursor': {}, 'items': [], 'drops': {}, 'scanned': 0}}
        with contextlib.ExitStack() as stack:
            for name, value in (('active_watchers', []), ('noise_rules', []), ('collect', (result, {})),
                                ('build_context', {}), ('payment_checks', ({}, None)),
                                ('renewal_checks', ({}, None)), ('charge_checks', ({}, set(), None)),
                                ('handled', ({}, {})), ('urgent_alerts', {}), ('withdrawal_statuses', None)):
                stack.enter_context(patch.object(t, name, return_value=value))
            stack.enter_context(patch.object(t, 'LIVE', self.root / 'live'))
            stack.enter_context(patch.object(t.time, 'time', return_value=2000))
            model = stack.enter_context(patch.object(t, 'classify', return_value=([], {'cost_usd': 0})))
            stack.enter_context(patch('builtins.print'))
            self.assertEqual(t.run(types.SimpleNamespace(dry_run_hours=None, report=None)), 0)
        self.assertEqual(len(model.call_args.args[0]), t.MAX_BATCH)
        state = t.read_json(self.root / 'cursor.json')
        self.assertEqual(state['queue'], [])
        batch = t.read_json(Path(state['outbox']['batch']))
        self.assertEqual([hit['id'] for hit in batch['hits']], ['saved'])

    def test_credential_timeout_never_kills_writer_and_uses_own_session(self):
        drained = threading.Event()
        release = threading.Event()
        def communicate(**kwargs):
            if kwargs:
                raise subprocess.TimeoutExpired(['credential'], 0.01)
            release.wait(2)
            drained.set()
            return 'fixture-secret', None
        process = unittest.mock.Mock(communicate=unittest.mock.Mock(side_effect=communicate))
        with patch.object(t.subprocess, 'Popen', return_value=process) as spawn:
            try:
                with self.assertRaisesRegex(TimeoutError, 'isolated session'):
                    t.prepare_mail_credentials('gmail', 0.01)
                self.assertTrue(spawn.call_args.kwargs['start_new_session'])
                process.kill.assert_not_called()
                process.terminate.assert_not_called()
            finally:
                release.set()
        self.assertTrue(drained.wait(2))

    def test_hung_refresh_across_two_runs_starts_exactly_one_process(self):
        release, drained = threading.Event(), threading.Event()
        inherited = []
        def communicate(**kwargs):
            if kwargs:
                raise subprocess.TimeoutExpired(['mock-refresh'], 8)
            try:
                release.wait()
                return 'fixture-secret', None
            finally:
                os.close(inherited[0])
                drained.set()
        process = unittest.mock.Mock(communicate=unittest.mock.Mock(side_effect=communicate))
        def spawn(*args, **kwargs):
            inherited.append(os.dup(kwargs['pass_fds'][0]))
            return process
        with patch.object(t.subprocess, 'Popen', side_effect=spawn) as popen, \
             patch.object(t, 'cached_mail_credential', return_value=None), \
             patch.object(t, 'run_mail_fetch') as fetch:
            try:
                with patch.object(t.time, 'time', return_value=1000):
                    with self.assertRaises(TimeoutError):
                        t.run_mail('gmail', self.request)
                with patch.object(t.time, 'time', return_value=1300):
                    with self.assertRaisesRegex(RuntimeError, 'refresh_inflight') as caught:
                        t.run_mail('gmail', self.request)
                info = caught.exception.mail_progress
                self.assertEqual(info['credential_error'], 'refresh_inflight')
                self.assertEqual(info['credential_inflight_age_s'], 300)
                popen.assert_called_once()
                fetch.assert_not_called()
                process.kill.assert_not_called()
                process.terminate.assert_not_called()
            finally:
                release.set()
        self.assertTrue(drained.wait(2))

    def test_inflight_refresh_uses_valid_cache_without_starting_a_process(self):
        path = t.credential_guard_path('gmail')
        path.write_text('{"started_at":1000}')
        with path.open() as guard:
            t.fcntl.flock(guard, t.fcntl.LOCK_EX)
            with patch.object(t, 'cached_mail_credential', return_value='fixture-secret'), \
                 patch.object(t.subprocess, 'Popen') as spawn, \
                 patch.object(t.time, 'time', return_value=1300):
                info = {}
                self.assertEqual(t.prepare_mail_credentials('gmail', 8, info), 'fixture-secret')
                self.assertEqual(info['credential_inflight_age_s'], 300)
            spawn.assert_not_called()

    def test_auth_healing_never_reuses_rejected_cache_while_refresh_is_inflight(self):
        path = t.credential_guard_path('gmail')
        path.write_text('{"started_at":1000}')
        with path.open() as guard:
            t.fcntl.flock(guard, t.fcntl.LOCK_EX)
            with patch.object(t, 'cached_mail_credential', return_value='rejected-fixture') as cache, \
                 patch.object(t.subprocess, 'Popen') as spawn:
                with self.assertRaisesRegex(RuntimeError, 'refresh_inflight'):
                    t.prepare_mail_credentials('gmail', 8, refresh=True)
            cache.assert_not_called()
            spawn.assert_not_called()

    def test_rejected_unexpired_oauth_credentials_refresh_outside_fetch_once(self):
        # Google rejects on the first AUTH; Outlook first rotates frontends. All
        # paths must signal the parent through the real helper's refresh call.
        for account in ('gmail', 'fund', 'juno', 'outlook'):
            for fast in (False, True):
                with self.subTest(account=account, fast=fast):
                    self.oauth_healing(account, fast)

    def oauth_healing(self, account, fast, *, still_rejected=False, accept_frontend=None,
                      transport_errors=(), reject_old=True, pinned=False, outer_retry=False):
        (self.root / f'mail-progress-{account}.json').unlink(missing_ok=True)
        helper_path = Path(t.__file__).resolve().parents[3] / 'local-helpers/libexec/mail/mail_oauth.py'
        real_load = t.load_module
        state = {'token': 'rejected-fixture', 'fetching': False, 'refreshes': 0,
                 'auths': [], 'frontends': []}
        def connection(host, ip=None, timeout=None):
            imap = types.SimpleNamespace(**vars(self.imap))
            imap.authenticate = lambda method, blob: authenticate(ip, method, blob)
            return imap
        def load(*_):
            oauth = real_load('healing_test_oauth', helper_path)
            oauth.STATE_DIR = str(self.root / 'oauth')
            oauth.ORTIE, oauth.KC_READ = 'fixture-ortie', 'fixture-kc-read'
            oauth._v4_addrs = lambda *a: ['frontend-1', 'frontend-2', 'frontend-3'] if pinned else []
            oauth._PinnedIMAP = connection
            oauth.log = lambda *a: None
            oauth.imaplib = types.SimpleNamespace(IMAP4=imaplib.IMAP4,
                                                  IMAP4_SSL=connection)
            oauth.time = types.SimpleNamespace(**vars(oauth.time))
            oauth.time.sleep = lambda *_: None
            return types.SimpleNamespace(mail_oauth=oauth, connect=lambda acct, timeout:
                oauth.xoauth2_connect(acct, 'host.invalid', 'user.invalid', timeout=timeout))
        def authenticate(ip, method, blob):
            auth = blob(None).decode()
            state['auths'].append('new' if 'accepted-fixture' in auth else 'old')
            state['frontends'].append(ip)
            if len(state['auths']) <= len(transport_errors):
                raise transport_errors[len(state['auths']) - 1]
            if ((reject_old and 'accepted-fixture' not in auth) or still_rejected
                    or (accept_frontend and ip != accept_frontend)):
                raise imaplib.IMAP4.error('User is authenticated but not connected')
        def ortie(command, **kwargs):
            self.assertFalse(state['fetching'], 'a refresh-capable command ran inside the fetch')
            if command[0] == 'fixture-kc-read':
                return types.SimpleNamespace(returncode=0, stdout=json.dumps(
                    {'issued_at': t.time.time() - 600, 'expires_in': 3600}))
            self.assertIsNone(kwargs['timeout'])
            if command[-1] == 'refresh':
                # Exercise the actual helper lock path while the watcher guard is held.
                with (self.root / 'oauth' / f'{account}.lock').open() as helper_lock:
                    with self.assertRaises(BlockingIOError):
                        t.fcntl.flock(helper_lock, t.fcntl.LOCK_EX | t.fcntl.LOCK_NB)
                state['refreshes'] += 1
                state['token'] = 'accepted-fixture'
            return types.SimpleNamespace(returncode=0, stdout=state['token'])
        def spawn(command, **kwargs):
            self.assertTrue(kwargs['start_new_session'])
            self.assertTrue(kwargs['pass_fds'])
            token = t.mail_credentials(account, refresh='--refresh-mail-credentials' in command)
            return types.SimpleNamespace(returncode=0, communicate=lambda **kw: (token, None))
        def fetch(name, command, **kwargs):
            state['fetching'] = True
            try:
                result = t.mail_worker(account, json.loads(kwargs['input']))
                return subprocess.CompletedProcess(command, 0, json.dumps(result), '')
            except Exception as error:
                return subprocess.CompletedProcess(command, 1, '', f'{type(error).__name__}: {error}')
            finally:
                state['fetching'] = False
        request = {**self.request, 'fast': fast}
        # HOME prevents the real helper from reading the owner's preferred Outlook IP.
        with patch.dict(os.environ, {'HOME': str(self.root)}), \
             patch.object(t, 'load_module', side_effect=load), \
             patch.object(t.subprocess, 'Popen', side_effect=spawn) as processes, \
             patch.object(t.subprocess, 'run', side_effect=ortie), \
             patch.object(t, 'run_helper', side_effect=fetch) as workers, \
             patch.object(t, 'fetch_verified', side_effect=self.fetch), \
             patch.object(t, 'mail_record', side_effect=self.record):
            # This rejection occurs with 50 minutes remaining on the access token.
            self.assertGreater(load().mail_oauth.seconds_left(account), 2900)
            if still_rejected:
                with self.assertRaisesRegex(RuntimeError, 'IMAP auth failed') as caught:
                    t.run_mail(account, request)
                info = caught.exception.mail_progress
                self.assertEqual(info['cursor_after'], request['cursor'])
            else:
                result = t.run_mail(account, request)
                info = result['mail_progress']
                self.assertEqual(result['cursor']['uid'], t.MAIL_LIMIT)
            refreshed = reject_old or bool(accept_frontend)
            self.assertEqual(state['refreshes'], int(refreshed))
            self.assertEqual(workers.call_count, 2 if refreshed or outer_retry else 1)
            self.assertEqual(processes.call_count, 2 if refreshed else 1)
            self.assertEqual(info['credential_refresh_attempts'], int(refreshed))
            if accept_frontend:
                self.assertEqual(state['frontends'], ['frontend-1', 'frontend-2',
                                                       'frontend-1', 'frontend-2', 'frontend-3'])
            elif not transport_errors:
                self.assertEqual(state['auths'], ['old'] * (2 if account == 'outlook' else 1)
                                 + ['new'] * ((8 if account == 'outlook' else 2) if still_rejected else 1))
            else:
                self.assertEqual(state['auths'][-1], 'new' if refreshed else 'old')
                if not refreshed:
                    self.assertEqual(len(state['auths']), len(transport_errors) + 1)

    def test_still_rejected_refreshed_token_does_not_start_another_refresh(self):
        for account in ('gmail', 'outlook'):
            with self.subTest(account=account):
                self.oauth_healing(account, False, still_rejected=True)

    def test_outlook_keeps_rotating_frontends_after_the_isolated_refresh(self):
        for fast in (False, True):
            with self.subTest(fast=fast):
                self.oauth_healing('outlook', fast, accept_frontend='frontend-3', pinned=True)

    def test_auth_transport_errors_rotate_without_refreshing_credentials(self):
        # abort is an IMAP4.error subclass. Other transport failures already have
        # their own branch in xoauth2_connect; exercise the entire transport class.
        errors = (imaplib.IMAP4.abort('socket error: EOF'),
                  imaplib.IMAP4.readonly('connection changed'),
                  ConnectionResetError('connection reset'), TimeoutError('timed out'),
                  ssl.SSLError('TLS connection dropped'))
        for account in ('gmail', 'fund', 'juno', 'outlook'):
            for fast in (False, True):
                for pinned in (False, True):
                    for error in errors:
                        with self.subTest(account=account, fast=fast, pinned=pinned, error=type(error).__name__):
                            self.oauth_healing(account, fast, pinned=pinned,
                                               transport_errors=(error,), reject_old=False)

    def test_transport_abort_does_not_consume_a_later_auth_healing_attempt(self):
        for account in ('gmail', 'outlook'):
            with self.subTest(account=account):
                self.oauth_healing(account, False,
                                   transport_errors=(imaplib.IMAP4.abort('socket error: EOF'),))

    def test_repeated_auth_aborts_preserve_the_outer_transport_retry(self):
        errors = (imaplib.IMAP4.abort('socket error: EOF'),
                  imaplib.IMAP4.abort('connection dropped'),
                  imaplib.IMAP4.readonly('connection changed'))
        for account in ('gmail', 'fund', 'juno', 'outlook'):
            for pinned in (False, True):
                for error in errors:
                    with self.subTest(account=account, pinned=pinned, error=str(error)):
                        # Exhaust the real helper, then let the outer retry succeed
                        # with the same token. Outlook has eight inner attempts.
                        attempts = 8 if account == 'outlook' else 2
                        self.oauth_healing(account, False, transport_errors=(error,) * attempts,
                                           reject_old=False, pinned=pinned, outer_retry=True)

    def test_auth_refresh_and_retry_share_original_account_budget(self):
        for fast, limit in ((False, 22), (True, 14)):
            with self.subTest(fast=fast):
                now = [100.0]
                def credentials(account, seconds, diagnostics, *, refresh=False):
                    self.assertLessEqual(seconds, 100 + limit - now[0])
                    now[0] += 1 if not refresh else seconds
                    return 'fixture-secret'
                def fetch(account, request, *, deadline):
                    if now[0] == 101:
                        now[0] += 7
                        raise t.MailAuthRejected('fixture auth rejection')
                    self.assertEqual(deadline, 100 + limit)
                    now[0] = deadline
                    raise TimeoutError('mail collector budget exceeded')
                with patch.object(t.time, 'monotonic', side_effect=lambda: now[0]), \
                     patch.object(t, 'prepare_mail_credentials', side_effect=credentials), \
                     patch.object(t, 'run_mail_fetch', side_effect=fetch):
                    with self.assertRaises(TimeoutError) as caught:
                        t.run_mail('gmail', {**self.request, 'fast': fast})
                self.assertEqual(now[0], 100 + limit)
                self.assertEqual(caught.exception.mail_progress['credential_refresh_attempts'], 1)

    def test_non_auth_fetch_failure_never_starts_a_healing_refresh(self):
        for account in ('icloud', 'gmail', 'fund', 'juno', 'outlook'):
            with self.subTest(account=account), \
                 patch.object(t, 'prepare_mail_credentials', return_value='fixture-secret') as credentials, \
                 patch.object(t, 'run_mail_fetch', side_effect=RuntimeError('connection reset')):
                with self.assertRaises(RuntimeError):
                    t.run_mail(account, self.request)
                credentials.assert_called_once()
                self.assertFalse(credentials.call_args.kwargs['refresh'])

    def test_auth_refresh_timeout_logs_credential_stage_without_advancing_cursor(self):
        with patch.object(t, 'prepare_mail_credentials', side_effect=[
                'rejected-fixture', TimeoutError('refresh continues in isolated session')]) as credentials, \
             patch.object(t, 'run_mail_fetch', side_effect=t.MailAuthRejected()) as fetch:
            with self.assertRaises(TimeoutError) as caught:
                t.run_mail('gmail', self.request)
        self.assertEqual(credentials.call_count, 2)
        self.assertTrue(credentials.call_args.kwargs['refresh'])
        fetch.assert_called_once()
        info = caught.exception.mail_progress
        self.assertEqual(info['stage'], 'credential')
        self.assertIn('isolated session', info['credential_error'])
        self.assertEqual(info['credential_refresh_attempts'], 1)
        self.assertEqual(info['cursor_after'], self.request['cursor'])

    def test_cache_read_is_bounded_read_only_and_rejects_expired_or_missing_token(self):
        mail = types.SimpleNamespace(mail_oauth=types.SimpleNamespace(KC_READ='fixture-kc-read'))
        for left, token, expected in ((120, 'fixture', 'fixture'), (0, 'fixture', None),
                                     (60, 'fixture', None), (120, '', None), (120, None, None)):
            blob = {'issued_at': 1000, 'expires_in': left, 'access_token': token}
            response = types.SimpleNamespace(returncode=0, stdout=json.dumps(blob))
            with self.subTest(left=left, has_token=bool(token)), \
                 patch.object(t, 'load_module', return_value=mail), \
                 patch.object(t.time, 'time', return_value=1000), \
                 patch.object(t.subprocess, 'run', return_value=response) as read:
                self.assertEqual(t.cached_mail_credential('gmail', 8), expected)
            self.assertEqual(read.call_args.args[0], ['fixture-kc-read', 'ortie-gmail'])
            self.assertEqual(read.call_args.kwargs['timeout'], 2)

    def test_guard_is_shared_by_normal_and_fast_checks(self):
        live = self.root / 'watchers/inbox-triage'
        with patch.object(t, 'LIVE', live):
            with patch.dict(os.environ, {'WATCH_DIR': str(live)}):
                normal = t.credential_guard_path('gmail')
            with patch.dict(os.environ, {'WATCH_DIR': str(live.parent / 'inbox-triage-fastpath')}):
                fast = t.credential_guard_path('gmail')
        self.assertEqual(normal, fast)

    def test_real_oauth_refresh_lock_completes_while_watcher_guard_is_held(self):
        helper_path = Path(t.__file__).resolve().parents[3] / 'local-helpers/libexec/mail/mail_oauth.py'
        oauth = t.load_module('guard_test_oauth', helper_path)
        calls = []
        real_flock = t.fcntl.flock
        def nonblocking_flock(file, operation):
            calls.append(Path(file.name))
            # Fail promptly if a regression makes refresh block on our inherited guard.
            return real_flock(file, operation | t.fcntl.LOCK_NB)
        def spawn(*args, **kwargs):
            self.assertTrue(oauth.refresh('gmail', force=True))
            return types.SimpleNamespace(returncode=0, communicate=lambda **kw: ('fixture-secret', None))
        state = self.root / 'mail-oauth'
        with patch.object(oauth, 'STATE_DIR', str(state)), \
             patch.object(oauth, 'LOG_FILE', str(state / 'heal.log')), \
             patch.object(oauth, 'token_age', return_value=1000), \
             patch.object(oauth.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)), \
             patch.object(t.fcntl, 'flock', side_effect=nonblocking_flock), \
             patch.object(t.subprocess, 'Popen', side_effect=spawn):
            self.assertEqual(t.prepare_mail_credentials('gmail', 8), 'fixture-secret')
        self.assertEqual(calls, [t.credential_guard_path('gmail'), state / 'gmail.lock'])

    def test_runner_group_kill_cannot_kill_credential_session(self):
        # Separate pipes gate both processes; no sleeps or race-dependent timeouts.
        ready_r, ready_w = os.pipe()
        go_r, go_w = os.pipe()
        self.addCleanup(os.close, ready_r)
        self.addCleanup(os.close, go_w)
        marker = self.root / 'refresh-finished'
        helper = self.root / 'credentials.py'
        helper.write_text('import os\nos.write('+str(ready_w)+', b"ready")\nos.read('+str(go_r)+', 1)\n'
                          +'open('+repr(str(marker))+', "w").write("finished")\nprint("fixture-secret")\n')
        wrapper = self.root / 'wrapper.py'
        wrapper.write_text('import importlib.util\n'
            +'s=importlib.util.spec_from_file_location("t", '+repr(str(Path(t.__file__)))+')\n'
            +'t=importlib.util.module_from_spec(s); s.loader.exec_module(t)\n'
            +'original=t.subprocess.Popen\n'
            +'def spawn(*a, **k):\n k["pass_fds"]=(*k.get("pass_fds", ()), '+str(ready_w)+', '+str(go_r)+')\n return original(*a, **k)\n'
            +'t.subprocess.Popen=spawn\nt.__file__='+repr(str(helper))+'\n'
            +'t.prepare_mail_credentials("gmail", 8)\n')
        parent = subprocess.Popen([sys.executable, '-I', str(wrapper)], start_new_session=True,
                                  pass_fds=(ready_w, go_r), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.close(ready_w)
        os.close(go_r)
        try:
            import select
            self.assertTrue(select.select([ready_r], [], [], 5)[0])
            self.assertEqual(os.read(ready_r, 5), b'ready')
            os.killpg(parent.pid, signal.SIGKILL)
            parent.wait(timeout=5)
            with t.credential_guard_path('gmail').open() as guard:
                with self.assertRaises(BlockingIOError):
                    t.fcntl.flock(guard, t.fcntl.LOCK_EX | t.fcntl.LOCK_NB)
            os.write(go_w, b'x')
            # EOF on the ready pipe proves the surviving credential process exited.
            self.assertTrue(select.select([ready_r], [], [], 5)[0])
            self.assertEqual(os.read(ready_r, 1), b'')
            self.assertEqual(marker.read_text(), 'finished')
        finally:
            if parent.poll() is None:
                os.killpg(parent.pid, signal.SIGKILL)
                parent.wait(timeout=5)


class ClassifierTests(unittest.TestCase):
    def test_age_cap_expires_even_when_only_one_prior_run_deferred(self):
        item = {'id': 'a'}
        self.assertEqual(t.defer_classifier_items([item], 1000), [])
        expired = t.defer_classifier_items([item], 1900)
        self.assertEqual(expired[0]['id'], 'a')
        self.assertEqual(item['classifier_deferred_runs'], 2)

    def test_retry_then_success_reports_attempts_and_budget(self):
        with patch.object(t, 'classify', side_effect=[TimeoutError(), ([], {'input_tokens': 12})]) as call:
            hits, meta = t.classify_batch([{'id': 'a'}], {}, 20)
        self.assertEqual(hits, [])
        self.assertEqual(call.call_count, 2)
        self.assertEqual(meta['classifier_attempts'], 2)
        self.assertEqual(meta['classifier_budget_ms'], 20000)
        self.assertEqual(meta['classifier_causes'][0]['cause'], 'socket_timeout')

    def test_retry_exhaustion_and_http_errors_log_specific_cause(self):
        for error, expected, attempts in (
            (TimeoutError('private response body'), 'socket_timeout', 2),
            (urllib.error.HTTPError(t.CLASSIFIER_ENDPOINT, 503, 'private response body', {}, None), 'http_status=503', 2),
            (urllib.error.HTTPError(t.CLASSIFIER_ENDPOINT, 401, 'private response body', {}, None), 'http_status=401', 1),
            (urllib.error.URLError(OSError('private response body')), 'url_error=OSError', 2),
            (ValueError('fixture validation; password="private response body"'), 'ValueError: fixture validation;', 1),
        ):
            with self.subTest(cause=expected), patch.object(t, 'classify', side_effect=error):
                hits, meta = t.classify_batch([{'id': 'a'}], {}, 20)
            self.assertEqual(hits[0]['id'], 'a')
            self.assertEqual(meta['classifier_attempts'], attempts)
            self.assertIn(expected, meta['classifier_error'])
            self.assertIn(t.CLASSIFIER_ENDPOINT, meta['classifier_error'])
            self.assertIn('elapsed_ms=', meta['classifier_error'])
            self.assertNotIn('private response body', json.dumps(meta))

    def test_starvation_defers_without_endpoint_call_or_manual_review_flood(self):
        with patch.object(t, 'classify') as call:
            hits, meta = t.classify_batch([{'id': 'a'}], {}, 3.4)
        call.assert_not_called()
        self.assertEqual(hits, [])
        self.assertTrue(meta['classifier_deferred'])
        self.assertEqual(meta['classifier_attempts'], 0)
        self.assertEqual(meta['classifier_budget_ms'], 3400)


if __name__ == '__main__':
    unittest.main()

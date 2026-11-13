"""Create and launch keep local output and registration without Telegram up notices."""
from pathlib import Path
import sys
from types import SimpleNamespace
from contextlib import ExitStack
import datetime as dt
import tempfile
import shutil
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skill/scripts'))
import rcsim


class Notifications(unittest.TestCase):
    def test_create_and_launch_never_send_even_without_no_notify(self):
        args = SimpleNamespace(thread=None, manager=None, platform='ios', name='test', purpose='test',
            model=None, region=None, hard_timeout='45m', inactivity_timeout='none', install=None,
            install_asset=None, no_notify=False, json=True, build='build', asset=None, idempotency_key='key')
        session = {'id': 'sim-test', 'url': 'https://example.test?token=fake-private'}
        for operation, result in [(rcsim.cmd_create, session), (rcsim.cmd_launch, {'session': session, 'id': 'launch'})]:
            with self.subTest(operation=operation.__name__), patch.object(rcsim, 'whoami', return_value={'thread':'test'}), \
                    patch.object(rcsim, 'refuse_unresolved'), patch.object(rcsim, 'db'), \
                    patch.object(rcsim, 'rc', return_value=(0, result, '', '')), \
                    patch.object(rcsim, 'register') as register, patch.object(rcsim, 'telegram') as telegram, \
                    patch.object(rcsim, 'print_created') as output:
                operation(args)
                telegram.assert_not_called()
                register.assert_called_once()
                self.assertIs(output.call_args.args[3], False)

    def test_adopted_sessions_are_logged_without_an_up_notice(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            for name, value in [('STATE_DIR', root), ('DB_PATH', root/'state.sqlite'),
                                ('LOCK_PATH', root/'lock'), ('LOG_PATH', root/'log'), ('TOUCH_LOG', root/'touch')]:
                stack.enter_context(patch.object(rcsim, name, value))
            stamp = dt.datetime.now(dt.timezone.utc)
            session = {'id': 'adopted', 'status': 'active', 'displayName': 'demo',
                       'createdAt': stamp.isoformat(), 'expiresAt': (stamp+dt.timedelta(minutes=40)).isoformat(),
                       'tags': {'owner-thread': 'owner'}, 'url': 'https://example.test?token=private'}
            stack.enter_context(patch.object(rcsim, 'rc', side_effect=lambda args, **kw:
                (0, [session] if args[0] == 'ios' else [], '', '')))
            stack.enter_context(patch.object(rcsim, 'thread_get', return_value=('ok', {'threadId':'owner'})))
            telegram = stack.enter_context(patch.object(rcsim, 'telegram'))
            con = rcsim.db()
            stack.callback(con.close)
            stack.enter_context(patch.object(rcsim, 'db', return_value=con))
            lock = (root/'lock').open('w')
            stack.callback(lock.close)
            stack.enter_context(patch.object(rcsim, 'open', return_value=lock, create=True))
            stack.enter_context(patch.object(rcsim, 'log', side_effect=lambda text:
                (root/'log').write_text(text)))
            rcsim.monitor()
            telegram.assert_not_called()
            self.assertIn('registered adopted as adopted', (root/'log').read_text())

    def test_bridge_cli_redacts_complete_values_for_runcloud_notifications(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture = root/'capture.txt'
            cli = Path(__file__).resolve().parents[2]/'telegram-bridge/src/cli.ts'
            stub = root/'cli.ts'
            stub.write_text(f'import {{ parseCommand }} from {str(cli)!r};\n'
                            f'await Bun.write({str(capture)!r}, parseCommand(process.argv.slice(2)).body.text);')
            for text in ['access_token=Bearer FAKE_SECRET', r'{"token":"one \"two\" FAKE_SECRET"}',
                         'token=https://example.test/?part=1&sig=FAKE_SECRET',
                         'access_token=Bearer https://example.test/?part=1&sig=FAKE_SECRET',
                         r'{\"token\":\"one \\\"two\\\" FAKE_SECRET\"}',
                         r'{"token":"prefix https://example.test/?sig=x\" FAKE_SECRET"}',
                         r'{\"token\":\"prefix https://example.test/?sig=x\\\" FAKE_SECRET\"}',
                         r'{"url":"https://example.test/?token=FAKE_PREFIX\\FAKE_SECRET"}',
                         r'{\"url\":\"https://example.test/?token=FAKE_PREFIX\\\\FAKE_SECRET\"}',
                         r'{"url":"https://example.test/?sig=FAKE_PREFIX\"FAKE_SECRET"}',
                         'https://example.test/token=FAKE_SECRET?sig=FAKE_QUERY',
                         r'{"url":"https://example.test/token=FAKE_SECRET?sig=FAKE_QUERY"}',
                         r'{\"url\":\"https://example.test/token=FAKE_SECRET?sig=FAKE_QUERY\"}',
                         r'{\"token\":\"prefix https://example.test/?sig=x\",\"access_token\":\"FAKE_OTHER\"}']:
                with self.subTest(text=text), patch.object(rcsim, 'BUN', shutil.which('bun')), \
                        patch.object(rcsim, 'TG_CLI', str(stub)):
                    self.assertTrue(rcsim.telegram(text, 'synthetic'))
                    safe = capture.read_text()
                    self.assertNotIn('FAKE_SECRET', safe)
                    self.assertNotIn('two', safe)
                    self.assertNotIn('FAKE_PREFIX', safe)
                    self.assertNotIn('FAKE_QUERY', safe)
                    self.assertNotIn('FAKE_OTHER', safe)

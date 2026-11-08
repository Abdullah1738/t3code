import datetime as dt
import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from importlib.machinery import SourceFileLoader
import sys

HELPERS = Path(__file__).resolve().parents[1] / 'helpers'
spec = importlib.util.spec_from_file_location('robob_readonly_test', HELPERS / 'robob_readonly.py')
ro = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ro)


class ReplicaTests(unittest.TestCase):
    def fixture(self, path, ready=1, updated=None):
        db = sqlite3.connect(path)
        db.execute('CREATE TABLE ardud_readonly_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        db.executemany('INSERT INTO ardud_readonly_meta VALUES (?,?)',
                       [('ready', str(ready)), ('updated_at', updated or dt.datetime.now(dt.timezone.utc).isoformat()),
                        ('schema_version', '1')])
        db.commit()
        db.close()

    def test_default_and_component_override(self):
        self.assertEqual(ro.replica_path('OWN', {'HOME': '/h'}), Path('/h/.robob/userdata/readonly/state.sqlite'))
        self.assertEqual(ro.replica_path('OWN', {'ROBOB_READONLY_DB': '/shared'}), Path('/shared'))
        self.assertEqual(ro.replica_path('OWN', {'OWN': '/own', 'ROBOB_READONLY_DB': '/shared'}), Path('/own'))

    def test_component_install_includes_its_snapshot_guard(self):
        source = HELPERS.parents[0] / 'checks/money-cases/install.py'
        install_spec = importlib.util.spec_from_file_location('replica_install_test', source)
        installer = importlib.util.module_from_spec(install_spec)
        install_spec.loader.exec_module(installer)
        with tempfile.TemporaryDirectory() as tmp, patch.object(installer.subprocess, 'run'):
            root = Path(tmp)
            installer.install(live=root / 'live', data=root / 'data', link=root / 'bin/money-cases')
            self.assertEqual((root / 'live/robob_readonly.py').read_bytes(), (HELPERS / 'robob_readonly.py').read_bytes())

    def test_live_aliases_rejected_before_connect(self):
        with tempfile.TemporaryDirectory() as tmp:
            live = Path(tmp) / '.robob/userdata/statev2.sqlite'
            live.parent.mkdir(parents=True)
            live.write_text('never SQLite-open this file')
            sym, chain, hard = (Path(tmp) / x for x in ('sym', 'chain', 'hard'))
            sym.symlink_to(live)
            chain.symlink_to(sym)
            os.link(live, hard)
            with patch.object(ro.Path, 'home', return_value=Path(tmp)), patch.object(ro.sqlite3, 'connect') as connect:
                for path in (live, sym, chain, hard):
                    with self.assertRaisesRegex(ValueError, 'refusing live Robob'):
                        ro.connect_replica(path)
                connect.assert_not_called()

    def test_configured_live_homes_and_native_aliases_rejected_before_connect(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            env = {'HOME': tmp, 'ROBOB_HOME': str(home / 'custom-robob'), 'T3CODE_HOME': '~/custom-t3',
                   'XDG_DATA_HOME': str(home / 'xdg')}
            roots = [home / '.robob', home / '.t3', home / 'custom-robob', home / 'custom-t3']
            lives = [root / 'userdata' / name for root in roots for name in ('statev2.sqlite', 'state.sqlite')]
            lives.extend([home / '.local/share/opencode/opencode.db', home / 'xdg/opencode/opencode.db'])
            with patch.dict(os.environ, env), patch.object(ro.Path, 'home', return_value=home), \
                    patch.object(ro.sqlite3, 'connect') as connect:
                for i, live in enumerate(lives):
                    live.parent.mkdir(parents=True, exist_ok=True)
                    live.write_text('never open this as SQLite')
                    sym, hard = home / f'sym-{i}', home / f'hard-{i}'
                    sym.symlink_to(live)
                    os.link(live, hard)
                    for path in (live, sym, hard):
                        with self.assertRaisesRegex(ValueError, 'refusing live Robob'):
                            ro.connect_replica(path)
                connect.assert_not_called()
            innocent = home / 'fixture/statev2.sqlite'
            innocent.parent.mkdir()
            self.fixture(innocent)
            db = ro.connect_replica(innocent)
            db.close()

    def test_ready_fresh_readonly_and_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'replica?#.sqlite'
            self.fixture(path)
            db = ro.connect_replica(path)
            with self.assertRaisesRegex(sqlite3.OperationalError, 'readonly'):
                db.execute('CREATE TABLE nope(x)')
            db.close()
            missing = Path(tmp) / 'missing.sqlite'
            with self.assertRaises(FileNotFoundError):
                ro.connect_replica(missing)
            self.assertFalse(missing.exists())

    def test_not_ready_stale_invalid_future_and_missing_meta(self):
        with tempfile.TemporaryDirectory() as tmp:
            now = dt.datetime.now(dt.timezone.utc)
            cases = [(0, now.isoformat()), (1, (now - dt.timedelta(seconds=121)).isoformat()),
                     (1, 'invalid'), (1, (now + dt.timedelta(minutes=1)).isoformat()),
                     (1, now.replace(tzinfo=None).isoformat())]
            for i, (ready, updated) in enumerate(cases):
                path = Path(tmp) / str(i)
                self.fixture(path, ready, updated)
                with self.assertRaises(ValueError):
                    ro.connect_replica(path)
            empty = Path(tmp) / 'empty'
            sqlite3.connect(empty).close()
            with self.assertRaises(sqlite3.OperationalError):
                ro.connect_replica(empty)
            wrong = Path(tmp) / 'wrong-schema'
            self.fixture(wrong)
            db = sqlite3.connect(wrong)
            db.execute("UPDATE ardud_readonly_meta SET value='2' WHERE key='schema_version'")
            db.commit()
            db.close()
            with self.assertRaisesRegex(ValueError, 'not ready'):
                ro.connect_replica(wrong)

    def test_transaction_pins_complete_generation_and_next_request_checks_ready(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'replica.sqlite'
            self.fixture(path)
            writer = sqlite3.connect(path)
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('CREATE TABLE data(value TEXT)')
            writer.execute("INSERT INTO data VALUES ('complete')")
            writer.commit()
            db = ro.connect_replica(path)
            writer.execute("UPDATE ardud_readonly_meta SET value='0' WHERE key='ready'")
            writer.execute("UPDATE data SET value='partial'")
            writer.commit()
            self.assertEqual(db.execute('SELECT value FROM data').fetchone(), ('complete',))
            with self.assertRaisesRegex(ValueError, 'not ready'):
                ro.connect_replica(path)
            db.close()
            writer.close()

    def test_send_approval_default_uses_control_messages_and_fails_closed(self):
        sys.path.insert(0, str(HELPERS))
        loader = SourceFileLoader('send_approval_readonly_test', str(HELPERS / 'send-approval'))
        app_spec = importlib.util.spec_from_loader(loader.name, loader)
        app = importlib.util.module_from_spec(app_spec)
        loader.exec_module(app)
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        messages = [dict(messageId='m1', role='assistant', streaming=False, createdAt=now, updatedAt=now,
                         text='preview', creationSource='provider', createdBy='agent'),
                    dict(messageId='m2', role='user', streaming=False, createdAt=now, updatedAt=now,
                         text='no, stop', creationSource='web', createdBy='user')]
        with patch.dict(os.environ, {}, clear=True), patch.object(app, 'control_get', return_value=(200, {'messages': messages})) as get, \
                patch.object(app, 'connect_replica') as connect:
            result = app.app_messages('thread:one')
            self.assertEqual([m['text'] for m in result], ['preview', 'no, stop'])
            self.assertIn('/threads/thread%3Aone/messages?all=true', get.call_args.args[0])
            connect.assert_not_called()
        with patch.dict(os.environ, {}, clear=True), patch.object(app, 'control_get', return_value=(200, {})), \
                patch.object(app, 'refuse', side_effect=ValueError('refused')), patch.object(app, 'connect_replica') as connect:
            with self.assertRaisesRegex(ValueError, 'refused'):
                app.app_messages('thread:one')
            connect.assert_not_called()
        since = app.ms_of(now) - 1
        baseline = [(app.ms_of(now), 'yes send it')]
        typed = dict(messages[1], text='yes send it')
        with patch.object(app, 'control_get', return_value=(200, {'messages': [typed]})):
            app.revalidate_app_stream('thread:one', baseline, since)
        with patch.object(app, 'control_get', return_value=(200, {'messages': [typed, messages[1]]})), \
                patch.object(app, 'refuse', side_effect=ValueError('new veto')):
            with self.assertRaisesRegex(ValueError, 'new veto'):
                app.revalidate_app_stream('thread:one', baseline, since)


if __name__ == '__main__':
    unittest.main()

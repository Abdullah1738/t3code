import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import poller
import rollup
import toollog


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None:
        from importlib.machinery import SourceFileLoader
        spec = importlib.util.spec_from_loader(name, SourceFileLoader(name, str(path)))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

image = load('genimg', ROOT.parent / 'local-helpers/libexec/image-generation/genimg.py')
keyhelper = load('keyhelper', ROOT.parent / 'local-helpers/bin/rclaude-key-helper')
FIXTURE = json.loads((ROOT / 'test/fixtures/poll.json').read_text())

class LoggingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'logs'
        self.env = patch.dict(os.environ, ROUTER_LOG_DIR=str(self.root))
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(self.tmp.cleanup)

    def tearDown(self):
        capture = os.environ.get('ROUTER_LOG_CAPTURE')
        if capture:
            with open(capture, 'a') as out:
                for path in self.root.glob('*.ndjson'):
                    if path.stat().st_size < 2 * 1024 * 1024:
                        out.write(path.read_text())

    def rows(self):
        return [json.loads(x) for p in self.root.glob('*.ndjson') for x in p.read_text().splitlines()]

    def test_format_privacy_modes_and_never_raises(self):
        toollog.emit('test', 'fixture.ok', kind='perf', durationMs=1.5, ok=True, ids={'account': 'fixture@example.invalid', 'apiKey': 'sk-fixture-do-not-log'}, props={'model': 'cx/gpt-image-2', 'size': '1024x1024', 'email': 'fixture@example.invalid', 'prompt': 'private prompt', 'tag': 'sk-fixture-do-not-log'}, error={'tag': 'http_502', 'message': 'sk-fixture-do-not-log fixture@example.invalid private prompt'})
        text = next(self.root.glob('*.ndjson')).read_text()
        for secret in ('sk-fixture-do-not-log', 'fixture@example.invalid', 'private prompt'):
            self.assertNotIn(secret, text)
        row = self.rows()[0]
        self.assertEqual(row['tool'], '9router')
        self.assertRegex(row['ts'], r'\.\d{3}Z$')
        self.assertEqual(row['durationMs'], 1.5)
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(next(self.root.glob('*.ndjson')).stat().st_mode), 0o600)
        self.assertLessEqual(len(row['error']['message']), 300)
        with patch.dict(os.environ, ROUTER_LOG_DIR=str(next(self.root.glob('*.ndjson')))):
            toollog.emit('test', 'fixture.failure')
        toollog.emit('test', 'fixture.failure', ids=None)
        toollog.emit('test', 'fixture.failure', durationMs=float('nan'))

    def test_retention_cap_and_cross_language_marker(self):
        self.root.mkdir()
        (self.root / '2000-01-01.ndjson').write_text('old')
        (self.root / 'rollup-2000-01-01.json').write_text('{}')
        (self.root / 'unrelated').write_text('keep')
        toollog.emit('test', 'fixture.first')
        self.assertFalse((self.root / '2000-01-01.ndjson').exists())
        self.assertFalse((self.root / 'rollup-2000-01-01.json').exists())
        path = next(self.root.glob('*.ndjson'))
        with path.open('r+b') as f:
            f.truncate(toollog.CAP)
        toollog.emit('test', 'fixture.dropped')
        toollog.emit('test', 'fixture.dropped')
        subprocess.run(['node', '--input-type=module', '-e', "import {emit} from './toollog.mjs'; emit('test','fixture.dropped');emit('test','fixture.error',{kind:'error',error:{tag:'http_502'}})"], cwd=ROOT, check=True)
        with path.open('rb') as f:
            f.seek(toollog.CAP)
            tail = f.read().decode()
        self.assertEqual(tail.count('log.cap'), 1)
        self.assertNotIn('fixture.dropped', tail)
        self.assertIn('fixture.error', tail)

    def test_rollup_fixture_and_cli(self):
        self.root.mkdir()
        rows = [dict(tool='9router', name='img.result', kind='perf', ok=True, durationMs=n) for n in range(1, 101)]
        rows += [dict(tool='9router', name='img.result', kind='error', ok=False, error={'tag': 'http_502'}, ids={'account': 'safe-id'})]
        (self.root / '2026-11-12.ndjson').write_text('\n'.join(map(json.dumps, rows)) + '\ninvalid\n')
        result = rollup.rollup('2026-11-12')
        self.assertEqual(result['countsByName']['img.result'], 101)
        self.assertEqual(result['durationMs']['img.result'], {'p50': 50, 'p95': 95, 'max': 100})
        self.assertEqual(result['topErrors'][0]['sampleIds'], {'account': 'safe-id'})
        self.assertEqual(result['malformed'], 1)
        output = subprocess.check_output([sys.executable, '-I', str(ROOT / 'run.py'), 'rollup', '--day', '2026-11-12'])
        self.assertEqual(json.loads(output)['total'], 101)
        self.assertEqual(stat.S_IMODE((self.root / 'rollup-2026-11-12.json').stat().st_mode), 0o600)

    def test_poller_gets_only_recorded_metadata_dedupes_and_rolls_over(self):
        calls = []
        def get(route):
            calls.append(route)
            return {'/api/providers': FIXTURE['providers'], '/api/usage/logs': FIXTURE['logs'], '/api/usage/stats?period=today': FIXTURE['stats']}[route]
        now = dt.datetime(2026, 11, 13, 0, 4, tzinfo=dt.timezone.utc)
        self.assertEqual(poller.poll(get, now=now), 0)
        self.assertFalse((self.root / 'rollup-2026-11-12.json').exists())
        self.assertEqual(poller.poll(get, now=now.replace(minute=5)), 0)
        self.assertTrue((self.root / 'rollup-2026-11-12.json').exists())
        self.assertEqual(calls.count('/api/usage/stats?period=today'), 1)
        rows = self.rows()
        errors = [r for r in rows if r['name'] == 'usage.errors']
        self.assertEqual([r['props']['status'] for r in errors], [429, 502])
        self.assertEqual(len([r for r in rows if r['name'] == 'spend.snapshot']), 1)
        self.assertEqual([r for r in rows if r['name'] == 'account.health'][0]['props']['locked'], True)
        self.assertEqual(len([r for r in rows if r['name'] == 'poll.complete' and r['ok']]), 2)
        def fail(_):
            raise urllib.error.HTTPError('http://localhost', 502, 'private prompt', {}, None)
        self.assertEqual(poller.poll(fail, now=now), 1)
        self.assertEqual(self.rows()[-1]['error']['tag'], 'http_502')
        text = ''.join(p.read_text() for p in self.root.iterdir() if p.is_file())
        for secret in ('fixture@example.invalid', 'sk-fixture-do-not-log', 'private prompt'):
            self.assertNotIn(secret, text)

    def test_spend_failure_does_not_replay_source_errors(self):
        self.root.mkdir()
        (self.root / '2026-11-12.ndjson').write_text(json.dumps({'tool': '9router', 'name': 'fixture.source', 'kind': 'event'}) + '\n')
        def get(route):
            if route == '/api/usage/stats?period=today':
                raise ValueError('spend unavailable')
            return FIXTURE['providers'] if route == '/api/providers' else FIXTURE['logs']
        self.assertEqual(poller.poll(get, now=dt.datetime(2026, 11, 13, 0, 5, tzinfo=dt.timezone.utc)), 1)
        self.assertEqual(poller.poll(get, now=dt.datetime(2026, 11, 13, 0, 10, tzinfo=dt.timezone.utc)), 1)
        self.assertEqual(json.loads((self.root / 'rollup-2026-11-12.json').read_text())['total'], 1)
        errors = [r for r in self.rows() if r['name'] == 'usage.errors']
        self.assertEqual(sum(r['props']['count'] for r in errors), 2)
        self.assertTrue(all(r['kind'] == 'error' and r['ok'] is False for r in errors))
        self.assertEqual({r['error']['tag'] for r in errors}, {'http_429', 'http_502'})

    def test_simultaneous_cross_language_cap_preserves_errors(self):
        self.root.mkdir()
        day = dt.datetime.now(dt.timezone.utc).date().isoformat()
        path = self.root / (day + '.ndjson')
        with path.open('wb') as out:
            out.truncate(toollog.CAP)
        python = "import sys;sys.path.insert(0,%r);from toollog import emit;emit('test','fixture.drop');emit('test','fixture.error',kind='error',error={'tag':'http_502'})" % str(ROOT)
        node = "import {emit} from './toollog.mjs';emit('test','fixture.drop');emit('test','fixture.error',{kind:'error',error:{tag:'http_502'}})"
        children = [subprocess.Popen(command, cwd=ROOT) for command in [[sys.executable, '-I', '-c', python], ['node', '--input-type=module', '-e', node]] * 4]
        for child in children:
            self.assertEqual(child.wait(timeout=15), 0)
        with path.open('rb') as source:
            source.seek(toollog.CAP)
            tail = source.read().decode()
        rows = [json.loads(line) for line in tail.splitlines()]
        self.assertEqual(sum(r['name'] == 'log.cap' for r in rows), 1)
        self.assertEqual(sum(r['name'] == 'fixture.error' for r in rows), 8)
        self.assertNotIn('fixture.drop', tail)
        if os.environ.get('ROUTER_LOG_CAPTURE'):
            with open(os.environ['ROUTER_LOG_CAPTURE'], 'a') as out:
                out.write(tail)

    def test_lock_input_class(self):
        now = dt.datetime(2026, 11, 13, tzinfo=dt.timezone.utc)
        for value, expected in [(None, False), ('', False), (False, False), (True, True), ('invalid', False), ('2099-01-01T00:00:00Z', True), ('2000-01-01T00:00:00+00:00', False), (now.timestamp()*1000+1000, True), (0, False)]:
            with self.subTest(value=value):
                self.assertEqual(poller.locked(value, now), expected)

    def test_image_success_failure_and_explicit_caller_fallback(self):
        def success(*_, **__):
            return io.BytesIO(b'{"data":[{"b64_json":"aGVsbG8="}]}')
        self.assertTrue(image.request_image('cx/gpt-image-2', '1024x1024', 'private prompt', 1, success)['data'])
        def fail(*_, **__):
            raise urllib.error.HTTPError('http://localhost', 502, 'bad', {}, io.BytesIO(b'{"error":"not_entitled sk-fixture-do-not-log"}'))
        with self.assertRaisesRegex(RuntimeError, 'http_502_not_entitled'):
            image.request_image('cx/gpt-image-2', '1024x1024', 'private prompt', 1, fail)
        image.request_image('cx/gpt-image-2', '1024x1024', 'private prompt', 1, fail, lambda *_: {'data': [1]})
        def fallback_fail(*_):
            raise ValueError('private prompt')
        with self.assertRaisesRegex(RuntimeError, 'fallback_failed'):
            image.request_image('cx/gpt-image-2', '1024x1024', 'private prompt', 1, fail, fallback_fail)
        names = [r['name'] for r in self.rows()]
        for name in ('img.request', 'img.result', 'img.fallback', 'img.fallback.result'):
            self.assertIn(name, names)
        self.assertNotIn('private prompt', json.dumps(self.rows()))
        self.assertNotIn('sk-fixture-do-not-log', json.dumps(self.rows()))

    def test_image_write_paths(self):
        args = ['genimg', 'private prompt', str(Path(self.tmp.name)/'out.png')]
        with patch.object(sys, 'argv', args), patch.object(image, 'request_image', return_value={'data': [{'b64_json': 'aGVsbG8='}]}), contextlib.redirect_stdout(io.StringIO()):
            image.main()
        args[-1] = str(Path(self.tmp.name)/'missing/out.png')
        with patch.object(sys, 'argv', args), patch.object(image, 'request_image', return_value={'data': [{'b64_json': 'aGVsbG8='}]}), self.assertRaises(SystemExit):
            image.main()
        self.assertEqual([r['ok'] for r in self.rows() if r['name'] == 'img.write'], [True, False])

    def test_keyhelper_stdout_and_log_privacy(self):
        with patch.dict(os.environ, RCLAUDE_API_KEY='sk-fixture-do-not-log'), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(keyhelper.main(), 0)
        self.assertEqual(out.getvalue(), 'sk-fixture-do-not-log\n')
        with patch.dict(os.environ, RCLAUDE_API_KEY=''):
            self.assertEqual(keyhelper.main(), 1)
        self.assertEqual([r['ok'] for r in self.rows()], [True, False])
        self.assertNotIn('sk-fixture-do-not-log', json.dumps(self.rows()))

if __name__ == '__main__':
    unittest.main()

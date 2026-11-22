import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import collector
import homebrew
import toollog


class HomebrewTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.opt = self.root/'opt'
        self.opt.mkdir()
        self.logs = self.root/'logs'
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.logs))
        env.start()
        self.addCleanup(env.stop)
        self.send = Mock(return_value=True)

    def rows(self, name='homebrew.integrity'):
        return [row for path in self.logs.glob('*.ndjson')
                for row in map(json.loads, path.read_text().splitlines()) if row['name'] == name]

    def runner(self, output='', code=0):
        return Mock(return_value=SimpleNamespace(stdout=output, stderr='', returncode=code))

    def test_only_dangling_symlinks_are_reported(self):
        target = self.root/'keg'
        target.mkdir()
        (self.opt/'good').symlink_to(target, target_is_directory=True)
        (self.opt/'broken').symlink_to('../Cellar/broken/1.0')
        (self.opt/'directory').mkdir()
        (self.opt/'file').write_text('ordinary file')
        self.assertEqual(homebrew.dangling_links(self.opt),
                         [dict(name='broken', target='../Cellar/broken/1.0')])

    def test_missing_parser_input_forms(self):
        cases = [('', []), (' \n\n', []),
                 ('gcloud-cli: python@3.13\n', [dict(formula='gcloud-cli', deps=['python@3.13'])]),
                 ('zstd: xz zlib\nanomalyco/tap/opencode-v2: node@26\n',
                  [dict(formula='anomalyco/tap/opencode-v2', deps=['node@26']),
                   dict(formula='zstd', deps=['xz', 'zlib'])]),
                 ('  zstd:\t zlib  xz\r\nzstd: xz\n', [dict(formula='zstd', deps=['xz', 'zlib'])])]
        for output, expected in cases:
            with self.subTest(output=output):
                self.assertEqual(homebrew.parse_missing(output), expected)
        for output in ('Error: something failed', 'gcloud-cli:', 'node: dep;echo', ': python'):
            with self.subTest(invalid=output), self.assertRaises(ValueError):
                homebrew.parse_missing(output)

    def test_healthy_run_logs_full_schema_without_alert(self):
        run = self.runner()
        props = homebrew.check(self.send, self.opt, run)
        row, = self.rows()
        self.assertEqual(props['status'], 'ok')
        self.assertEqual(row['props'], props)
        self.assertEqual((row['props']['dangling'], row['props']['missing']), ([], []))
        self.assertGreaterEqual(row['durationMs'], 0)
        self.assertTrue(row['ok'])
        self.send.assert_not_called()
        args, kwargs = run.call_args
        self.assertEqual(args[0], ['/opt/homebrew/bin/brew', 'missing'])
        self.assertEqual(kwargs['timeout'], 60)
        self.assertEqual(kwargs['env']['HOMEBREW_NO_AUTO_UPDATE'], '1')
        self.assertEqual(kwargs['env']['HOMEBREW_NO_ANALYTICS'], '1')

    def test_broken_run_logs_links_and_missing_deps_and_alerts_once(self):
        (self.opt/'pcre2').symlink_to('../Cellar/pcre2/10.49')
        run = self.runner('gcloud-cli: python@3.13\n', code=1)
        for _ in range(2):
            props = homebrew.check(self.send, self.opt, run)
        self.assertEqual(props['status'], 'broken')
        self.assertEqual(len(self.rows()), 2)
        self.assertEqual(self.rows()[0]['props']['dangling'],
                         [dict(name='pcre2', target='../Cellar/pcre2/10.49')])
        self.assertEqual(self.rows()[0]['props']['missing'],
                         [dict(formula='gcloud-cli', deps=['python@3.13'])])
        self.send.assert_called_once()
        text, key = self.send.call_args.args
        self.assertIn('gcloud-cli missing python@3.13', text)
        self.assertIn('pcre2 -> ../Cellar/pcre2/10.49', text)
        self.assertIn('brew reinstall -- pcre2', text)
        self.assertIn('brew reinstall -- gcloud-cli', text)
        self.assertNotIn('rm -rf', text)
        self.assertRegex(key, r'^mac-upkeep:homebrew-integrity:[a-f0-9]{40}$')

    def test_dangling_link_alone_alerts(self):
        (self.opt/'pcre2').symlink_to('../Cellar/pcre2/10.49')
        self.assertEqual(homebrew.check(self.send, self.opt, self.runner())['status'], 'broken')
        self.send.assert_called_once()

    def test_probe_errors_never_alert_even_with_a_dangling_link(self):
        (self.opt/'pcre2').symlink_to('../Cellar/pcre2/10.49')
        cases = [(FileNotFoundError(), 'brew_absent'),
                 (subprocess.TimeoutExpired('brew', 60), 'brew_timeout'),
                 (PermissionError(), 'brew_unavailable')]
        for error, reason in cases:
            with self.subTest(reason=reason):
                props = homebrew.check(self.send, self.opt, Mock(side_effect=error))
                self.assertEqual(props['status'], 'error')
                self.assertEqual(self.rows()[-1]['props']['reason'], reason)
                self.assertFalse(self.rows()[-1]['ok'])
        self.send.assert_not_called()

    def test_missing_opt_root_is_error(self):
        run = self.runner()
        props = homebrew.check(self.send, self.root/'absent', run)
        self.assertEqual((props['status'], props['reason']), ('error', 'opt_unavailable'))
        run.assert_not_called()
        self.send.assert_not_called()

    def test_brew_execution_and_parse_failures_are_errors(self):
        for output, code, reason in [('', 1, 'brew_exit'), ('node: xz', 2, 'brew_exit'),
                                     ('failure message', 0, 'brew_parse'),
                                     ('node:', 1, 'brew_parse')]:
            with self.subTest(output=output, code=code):
                props = homebrew.check(self.send, self.opt, self.runner(output, code))
                self.assertEqual((props['status'], props['reason']), ('error', reason))
        self.send.assert_not_called()

    def test_key_and_text_ignore_order_and_timing_but_track_new_breakage(self):
        a = dict(dangling=[dict(name='b', target='two'), dict(name='a', target='one')],
                 missing=[dict(formula='z', deps=['y', 'x']), dict(formula='a', deps=['b'])])
        b = dict(dangling=list(reversed(a['dangling'])), durationMs=1000,
                 missing=[dict(formula='a', deps=['b']), dict(formula='z', deps=['x', 'y'])])
        self.assertEqual(homebrew.alert_content(a), homebrew.alert_content(b))
        b['missing'][0]['deps'].append('c')
        self.assertNotEqual(homebrew.alert_content(a)[0], homebrew.alert_content(b)[0])

    def test_notification_failures_retry_exact_key_and_text(self):
        run = self.runner('gcloud-cli: python@3.13', 1)
        self.send.side_effect = [subprocess.TimeoutExpired('notify', 20), False, True]
        for _ in range(4):
            homebrew.check(self.send, self.opt, run)
        self.assertEqual(self.send.call_count, 3)
        self.assertEqual(len(set(call.args for call in self.send.call_args_list)), 1)
        self.assertEqual([r['ok'] for r in self.rows('homebrew.integrity_alert')], [False, False, True])
        self.assertEqual(len(self.rows()), 4)

    def test_large_alert_shapes_are_bounded_without_losing_event_findings(self):
        links = [dict(name='formula-%03d' % n, target='../Cellar/formula-%03d/1.0' % n)
                 for n in range(200)]
        missing = [dict(formula='formula-%03d' % n, deps=['dep-%03d' % n, 'python@3.13'])
                   for n in range(200)]
        cases = [
            ('many-links', links, []),
            ('many-missing', [], missing),
            ('mixed', links[:100], missing[:100]),
            ('long-target', [dict(name='pcre2', target='x'*4000)], []),
            ('unicode', [dict(name='formula-%03d' % n, target='\U0001f332'*128) for n in range(200)], []),
            ('long-name', [dict(name='x'*255, target='y'*4000)], []),
        ]
        for name, dangling, dependencies in cases:
            with self.subTest(name=name):
                props = dict(status='broken', dangling=dangling, missing=dependencies, durationMs=1)
                send = Mock(return_value=True)
                with patch.object(homebrew, 'collect', return_value=props), \
                     patch.object(homebrew, 'read_state', return_value={}), \
                     patch.object(homebrew, 'save_state'):
                    homebrew.check(send)
                row = self.rows()[-1]
                self.assertEqual(row['props']['dangling'], dangling)
                self.assertEqual(row['props']['missing'], dependencies)
                text, key = send.call_args.args
                self.assertLessEqual(len(text.encode('utf-8')), 3000)
                self.assertLessEqual(len(text.encode('utf-16-le'))//2, 4096)
                self.assertIn('brew reinstall -- ', text)
                reversed_props = dict(dangling=list(reversed(dangling)), missing=list(reversed(dependencies)))
                self.assertEqual((key, text), homebrew.alert_content(reversed_props))
                if len(dangling)+len(dependencies) > 100:
                    self.assertIn('more findings; see homebrew.integrity logs', text)
                    changed = dict(dangling=dangling+[dict(name='zz-last', target='new')], missing=dependencies)
                    self.assertNotEqual(key, homebrew.alert_content(changed)[0])

    def test_hourly_collector_records_probe_and_continues_after_error(self):
        probe = homebrew.check
        with patch.object(collector, 'missing_day'), \
             patch.object(collector, 'homebrew_integrity',
                          side_effect=lambda send: probe(send, self.opt, Mock(side_effect=FileNotFoundError()))), \
             patch.object(collector, 'notify') as notify, \
             patch.object(collector, 'collect') as crashes, \
             patch.object(collector, 'disk_wait'), patch.object(collector, 'disk_tooling_probe'), \
             patch.object(collector, 'directory_inventory') as inventory, \
             patch('disk_budgets.sample'):
            collector.main()
        row, = self.rows()
        self.assertEqual(row['props']['status'], 'error')
        notify.assert_not_called()
        crashes.assert_called_once()
        inventory.assert_called_once()

    def test_logger_retains_only_integrity_schema_and_redacts_secrets(self):
        props = dict(status='broken', dangling=[dict(name='pcre2', target='password=value')],
                     missing=[dict(formula='gcloud-cli', deps=['python@3.13'])], raw='private stdout')
        clean = toollog.safe_fields(props, 'homebrew.integrity')
        self.assertNotIn('raw', clean)
        self.assertEqual(clean['dangling'][0]['target'], '[redacted]')
        self.assertEqual(clean['missing'], props['missing'])


if __name__ == '__main__':
    unittest.main()

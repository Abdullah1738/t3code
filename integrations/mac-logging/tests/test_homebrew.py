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
        self.cellar = self.root/'Cellar'
        self.cellar.mkdir()
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

    def keg(self, name, deps=()):
        target = self.cellar/name/'1.0'
        target.mkdir(parents=True)
        (self.opt/name).symlink_to(target)
        (target/'INSTALL_RECEIPT.json').write_text(json.dumps(dict(
            runtime_dependencies=[dict(full_name=dep) for dep in deps])))
        return target

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
        self.assertEqual(args[0], ['/usr/bin/nice', '-n', '15', '/opt/homebrew/bin/brew', 'missing'])
        self.assertEqual(kwargs['timeout'], 240)
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

    def test_dangling_link_alerts_despite_secondary_probe_failure(self):
        (self.opt/'pcre2').symlink_to('../Cellar/pcre2/10.49')
        cases = [(Mock(side_effect=FileNotFoundError()), 'brew_absent'),
                 (Mock(side_effect=subprocess.TimeoutExpired('brew', 240)), 'brew_timeout'),
                 (Mock(side_effect=PermissionError()), 'brew_unavailable'),
                 (self.runner('', 1), 'brew_exit'), (self.runner('invalid output'), 'brew_parse'),
                 (self.runner('', 127), 'brew_absent')]
        for run, reason in cases:
            with self.subTest(reason=reason):
                props = homebrew.check(self.send, self.opt, run)
                self.assertEqual(props['status'], 'broken')
                self.assertEqual(self.rows()[-1]['props']['brewError'], reason)
                self.assertFalse(self.rows()[-1]['ok'])
        self.send.assert_called_once()
        self.assertEqual(self.send.call_args.args[1],
                         'mac-upkeep:homebrew-integrity:50156648504ca95d176ec5c36bcaaf129ff24818')

    def test_clean_local_checks_survive_secondary_probe_failure(self):
        for error, reason in [(FileNotFoundError(), 'brew_absent'),
                              (subprocess.TimeoutExpired('brew', 240), 'brew_timeout'),
                              (PermissionError(), 'brew_unavailable')]:
            with self.subTest(reason=reason):
                props = homebrew.check(self.send, self.opt, Mock(side_effect=error))
                self.assertEqual(props['status'], 'ok')
                self.assertEqual(self.rows()[-1]['props']['brewError'], reason)
                self.assertTrue(self.rows()[-1]['ok'])
        self.send.assert_not_called()

    def test_missing_opt_root_is_error(self):
        run = Mock(side_effect=FileNotFoundError())
        props = homebrew.check(self.send, self.root/'absent', run)
        self.assertEqual((props['status'], props['reason']), ('error', 'opt_unavailable'))
        run.assert_called_once()
        self.send.assert_not_called()

    def test_brew_execution_and_parse_failures_do_not_mask_local_checks(self):
        for output, code, reason in [('', 1, 'brew_exit'), ('node: xz', 2, 'brew_exit'),
                                     ('', 127, 'brew_absent'), ('', 126, 'brew_unavailable'),
                                     ('failure message', 0, 'brew_parse'),
                                     ('node:', 1, 'brew_parse')]:
            with self.subTest(output=output, code=code):
                props = homebrew.check(self.send, self.opt, self.runner(output, code))
                self.assertEqual((props['status'], props['brewError']), ('ok', reason))
        self.send.assert_not_called()

    def test_key_and_text_ignore_order_and_timing_but_track_new_breakage(self):
        a = dict(dangling=[dict(name='b', target='two'), dict(name='a', target='one')],
                 missing=[dict(formula='z', deps=['y', 'x']), dict(formula='a', deps=['b'])])
        b = dict(dangling=list(reversed(a['dangling'])), durationMs=1000, receiptErrors=4,
                 brewError='brew_timeout',
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

    def test_hourly_collector_records_probe_and_continues_after_brew_error(self):
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
        self.assertEqual(row['props']['status'], 'ok')
        self.assertEqual(row['props']['brewError'], 'brew_absent')
        notify.assert_not_called()
        crashes.assert_called_once()
        inventory.assert_called_once()

    def test_logger_retains_only_integrity_schema_and_redacts_secrets(self):
        props = dict(status='broken', brewError='brew_timeout', receiptErrors=3,
                     dangling=[dict(name='pcre2', target='password=value')],
                     missing=[dict(formula='gcloud-cli', deps=['python@3.13'])], raw='private stdout')
        clean = toollog.safe_fields(props, 'homebrew.integrity')
        self.assertNotIn('raw', clean)
        self.assertEqual(clean['dangling'][0]['target'], '[redacted]')
        self.assertEqual(clean['missing'], props['missing'])
        self.assertEqual(clean['brewError'], 'brew_timeout')
        self.assertEqual(clean['receiptErrors'], 3)

    def test_receipt_dependencies_present_missing_and_tap_qualified(self):
        self.keg('rg', ['homebrew/core/pcre2', 'xz', 'custom/tap/other'])
        self.keg('pcre2')
        # A keg without its opt link does not satisfy the runtime dependency.
        (self.cellar/'xz'/'1.0').mkdir(parents=True)
        props = homebrew.check(self.send, self.opt, self.runner(), cellar_root=self.cellar)
        self.assertEqual(props['status'], 'broken')
        self.assertEqual(props['missing'], [dict(formula='rg', deps=['other', 'xz'])])
        self.assertEqual(self.rows()[-1]['props']['receiptErrors'], 0)
        self.send.assert_called_once()

    def test_missing_receipt_dependency_alerts_on_brew_timeout_and_dedupes_with_brew(self):
        self.keg('rg', ['pcre2', 'pcre2'])
        failed = homebrew.check(self.send, self.opt,
                                Mock(side_effect=subprocess.TimeoutExpired('brew', 240)),
                                cellar_root=self.cellar)
        successful = homebrew.check(self.send, self.opt, self.runner('rg: pcre2 pcre2\n', 1),
                                    cellar_root=self.cellar)
        expected = [dict(formula='rg', deps=['pcre2'])]
        self.assertEqual(failed['status'], 'broken')
        self.assertEqual(successful['missing'], expected)
        self.assertEqual(failed['missing'], expected)
        self.assertEqual(homebrew.alert_content(failed), homebrew.alert_content(successful))
        self.send.assert_called_once()

    def test_dependency_identity_forms_keep_the_same_key_across_sources(self):
        cases = [
            ('plain', ['other'], 'other', False, ['other']),
            ('core-receipt', ['homebrew/core/other'], 'other', False, ['other']),
            ('qualified-brew', ['other'], 'custom/tap/other', False, ['other']),
            ('qualified-both', ['custom/tap/other'], 'custom/tap/other', False, ['other']),
            ('mixed-aliases', ['custom/tap/other', 'other'],
             'other custom/tap/other homebrew/core/other', False, ['other']),
            ('qualified-formula', ['other'], 'custom/tap/other', True, ['other']),
            ('versioned', ['python@3.13'], 'homebrew/core/python@3.13', False, ['python@3.13']),
            ('punctuation', ['custom/tap/libfoo++'], 'libfoo++', False, ['libfoo++']),
        ]
        for index, (name, receipt_deps, brew_deps, qualified_formula, expected) in enumerate(cases):
            with self.subTest(name=name):
                case = self.root/name
                opt, cellar = case/'opt', case/'Cellar'
                opt.mkdir(parents=True)
                formula = 'consumer-%d' % index
                target = cellar/formula/'1.0'
                target.mkdir(parents=True)
                (opt/formula).symlink_to(target)
                (target/'INSTALL_RECEIPT.json').write_text(json.dumps(dict(
                    runtime_dependencies=[dict(full_name=dep) for dep in receipt_deps])))
                brew_formula = 'custom/tap/'+formula if qualified_formula else formula
                timeout = Mock(side_effect=subprocess.TimeoutExpired('brew', 240))
                success = self.runner(brew_formula+': '+brew_deps+'\n', 1)
                self.send.reset_mock()
                before = homebrew.check(self.send, opt, timeout, cellar_root=cellar)
                after = homebrew.check(self.send, opt, success, cellar_root=cellar)
                self.assertEqual(before['missing'], [dict(formula=formula, deps=expected)])
                self.assertEqual(after['missing'], before['missing'])
                self.assertEqual(homebrew.alert_content(before), homebrew.alert_content(after))
                self.send.assert_called_once()

    def test_cask_secondary_identity_forms_dedupe_without_receipts(self):
        for output in ('a-cask: other\n', 'custom/tap/a-cask: custom/tap/other other\n'):
            props = homebrew.check(self.send, self.opt, self.runner(output, 1), cellar_root=self.cellar)
            self.assertEqual(props['missing'], [dict(formula='a-cask', deps=['other'])])
        self.send.assert_called_once()

    def test_unreadable_and_malformed_receipts_are_counted_and_other_kegs_continue(self):
        cases = [('syntax', '{'), ('shape', '[]'), ('deps-shape', '{"runtime_dependencies": {}}'),
                 ('dep-shape', '{"runtime_dependencies": [{}]}'), ('absent', None)]
        for name, content in cases:
            receipt = self.keg(name)/'INSTALL_RECEIPT.json'
            if content is None:
                receipt.unlink()
            else:
                receipt.write_text(content)
        denied = (self.keg('denied')/'INSTALL_RECEIPT.json').resolve()
        read_text = Path.read_text
        def read(path, *args, **kwargs):
            if path == denied:
                raise PermissionError('fixture')
            return read_text(path, *args, **kwargs)
        self.keg('rg', ['pcre2'])
        with patch.object(Path, 'read_text', read):
            props = homebrew.check(self.send, self.opt, self.runner(), cellar_root=self.cellar)
        self.assertEqual(props['receiptErrors'], len(cases)+1)
        self.assertEqual(props['missing'], [dict(formula='rg', deps=['pcre2'])])
        self.assertEqual(props['status'], 'broken')

    def test_only_opt_links_to_their_cellar_version_are_receipt_inputs(self):
        (self.opt/'plain').mkdir()
        external = self.root/'external'/'1.0'
        external.mkdir(parents=True)
        (self.opt/'external').symlink_to(external)
        other = self.cellar/'other'/'1.0'
        other.mkdir(parents=True)
        (self.opt/'wrong-name').symlink_to(other)
        (self.opt/'nested').symlink_to(self.cellar/'nested'/'1.0'/'bin')
        (self.cellar/'nested'/'1.0'/'bin').mkdir(parents=True)
        props = homebrew.check(self.send, self.opt, self.runner(), cellar_root=self.cellar)
        self.assertEqual(props['status'], 'ok')
        self.assertEqual(props['receiptErrors'], 0)
        self.send.assert_not_called()

    def test_secondary_cask_result_still_works_when_opt_is_unavailable(self):
        for output, code, status in [('', 0, 'ok'), ('a-cask: dep\n', 1, 'broken')]:
            with self.subTest(status=status):
                props = homebrew.check(self.send, self.root/'absent', self.runner(output, code),
                                        cellar_root=self.cellar)
                self.assertEqual(props['status'], status)


if __name__ == '__main__':
    unittest.main()

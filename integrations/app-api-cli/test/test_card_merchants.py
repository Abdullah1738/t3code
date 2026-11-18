import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import card_status as cs
import card_merchants as cm


class MerchantCards(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / 'card-status.json'
        self.routes_path = Path(tmp.name) / 'card_routes.json'
        self.routes_path.write_bytes(cm.ROUTES.read_bytes())
        self.config = json.loads(self.routes_path.read_text())
        routes = patch.object(cm, 'ROUTES', self.routes_path)
        routes.start()
        self.addCleanup(routes.stop)
        env = patch.dict(os.environ, {'CARD_STATUS_FILE': str(self.path),
                                    'TOOLLOG_ROOT': str(Path(tmp.name) / 'tool-logs'),
                                    'ROBOB_TOOL_LOG_DIR': str(Path(tmp.name) / 'tool-logs')})
        env.start()
        self.addCleanup(env.stop)

    def cli(self, *args):
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            code = cs.main(list(args))
        return code, out.getvalue(), err.getvalue()

    def seed(self):
        cs.record_cancelled('5542', reason='cancelled 29 Oct')
        cm.seed()

    def test_seed_roundtrip_primary_change_and_rerun(self):
        self.seed()
        self.assertEqual({r['key'] for r in cm.list_merchants(dead=True)}, {'bupa', 'boat.dev', 'openai'})
        rows = {r['key']: r for r in cm.list_merchants()}
        self.assertEqual(rows['stripe link']['cards'], [])
        self.assertEqual(rows['bupa']['next_charge'], '2027-01-03')
        self.assertEqual([c['last4'] for c in rows['amazon']['cards']], ['2342', '2792'])
        code, out, err = self.cli('merchant', 'set', 'BOAT.dev', '7572', '--role', 'primary', '--source', 'billing page', '--seen', '2026-11-13')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)['cards'][0]['last4'], '7572')
        self.assertIn('open invoices', err)
        self.assertIn('24 h', err)
        cm.seed()
        self.assertEqual({r['key'] for r in cm.list_merchants(dead=True)}, {'bupa', 'openai'})
        cm.set_card('OpenAI (ChatGPT)', 'none', source='removed at merchant')
        self.assertEqual({r['key'] for r in cm.list_merchants(dead=True)}, {'bupa'})
        self.assertEqual(self.cli('merchant', 'list', '--json')[0], 0)
        self.assertEqual(self.cli('merchant', 'dead', '--json')[0], 0)

    def test_saved_backup_declines_and_removal(self):
        cm.set_card('Acme', '2342')
        cm.set_card('Acme', '7572', role='backup')
        cs.record_declined('7572', reason='declined', now=1)
        self.assertEqual(cm.list_merchants(dead=True)[0]['dead_cards'], [{'last4': '7572', 'state': 'declined'}])
        self.assertEqual(self.cli('merchant', 'remove', 'Acme', '7572')[0], 0)
        self.assertEqual(cm.list_merchants(dead=True), [])
        self.assertFalse(cm.merchant_path().stat().st_mode & 0o077)
        self.assertTrue(cs.check('7572')['state'] == 'declined')

    def test_two_live_openai_cards_stay_listed(self):
        self.assertEqual(self.cli('merchant', 'set', 'OpenAI', '2342', '--source', 'new Pro sub')[0], 0)
        self.assertEqual(self.cli('merchant', 'set', 'ChatGPT', '7572', '--role', 'backup',
                                  '--source', 'five existing Pro subs')[0], 0)
        code, out, _ = self.cli('merchant', 'list', '--json')
        self.assertEqual(code, 0)
        rows = json.loads(out)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['key'], 'openai')
        self.assertEqual([(c['last4'], c['role']) for c in rows[0]['cards']],
                         [('2342', 'primary'), ('7572', 'backup')])
        self.assertEqual(self.cli('assert-final', 'openai', '7572')[0], 0)
        self.assertEqual(self.cli('merchant', 'remove', 'openai', '7572')[0], 0)
        self.assertEqual([c['last4'] for c in cm.list_merchants()[0]['cards']], ['2342'])

    def test_only_last_four_and_valid_metadata_persist(self):
        for last4 in ('12345', '4242424242424242', '4242 4242 4242 4242', 'abcd', '٥٥٤٢', '234', '2342\n'):
            with self.subTest(last4=last4):
                self.assertEqual(self.cli('merchant', 'set', 'test', last4)[0], 2)
        for args in (('test', '2342', '--seen', '2026-02-30'), ('test', '2342', '--next-charge', '2027-1-3'),
                     ('test', '2342', '--source', '4242-4242-4242-4242'), ('4242424242424242', '2342')):
            with self.subTest(args=args):
                self.assertEqual(self.cli('merchant', 'set', *args)[0], 2)
        self.assertFalse(cm.merchant_path().exists())

    def test_guard_corpus(self):
        rows = [
            ('noon', '9546', False, 0), ('noon', '2342', False, 3), ('noon', '2342', True, 0),
            ('noon food', '9546', False, 0), ('noon-food', '2342', False, 3),
            ('noon_minutes', '9546', False, 0), ('noon.com', '2342', False, 3), ('food', '9546', False, 0), ('Noon Minutes', '2342', False, 3),
            ('noon nownow', '9546', False, 0), ('noon main', '9546', False, 0),
            ('noon supermall', '9546', False, 0), ('Amazon app', '2342', False, 0),
            ('amazon.ae', '2792', True, 3), ('Uber Lux', '2342', False, 0),
            ('Uber', '9546', True, 3), ('boat.dev', '7572', False, 0), ('ChatGPT', '7572', False, 0),
            ('unknown merchant', '2342', False, 0), ('unknown merchant', '7572', False, 3),
            ('noon', '12345', False, 3), ('noon', '٥٥٤٢', False, 3),
        ]
        for merchant, last4, fallback, expected in rows:
            with self.subTest(merchant=merchant, last4=last4, fallback=fallback):
                args = ['assert-final', merchant, last4] + (['--fallback'] if fallback else [])
                self.assertEqual(self.cli(*args)[0], expected)
        for merchant in ('noon', 'Amazon app', 'Uber', 'boat.dev', 'anything'):
            self.assertEqual(self.cli('assert-final', merchant, '5542', '--fallback')[0], 3)
        cs.record_cancelled('9546', reason='lost')
        self.assertEqual(self.cli('assert-final', 'noon', '9546')[0], 3)
        cs.record_declined('2342', reason='funds')
        self.assertEqual(self.cli('assert-final', 'amazon', '2342')[0], 3)

    def test_guard_fails_closed_on_broken_routes_or_status(self):
        self.path.write_text('bad')
        self.assertEqual(self.cli('assert-final', 'amazon', '2342')[0], 3)
        with patch.object(cm, 'ROUTES', self.path):
            self.assertEqual(self.cli('assert-final', 'amazon', '2342')[0], 3)

    def test_openai_any_card_and_aliases(self):
        for merchant in ('openai', 'OpenAI', 'openai (chatgpt)', 'ChatGPT', 'openai billing'):
            for last4 in ('7572', '2342', '9546', '1234'):
                for fallback in ([], ['--fallback']):
                    with self.subTest(merchant=merchant, last4=last4, fallback=fallback):
                        self.assertEqual(self.cli('assert-final', merchant, last4, *fallback)[0], 0)

    def test_invalid_last_four_refused_on_any_route(self):
        for last4 in ('abcd', '123', '12345', '', '٥٥٤٢', '２３４２', '2342\n', ' 2342', '23-42',
                      '4242424242424242'):
            with self.subTest(last4=last4):
                code, out, _ = self.cli('assert-final', 'openai', last4)
                self.assertEqual(code, 3)
                self.assertIn('exactly the last 4 digits', out)

    def test_global_refusals_precede_every_route_and_status(self):
        for merchant in (*self.config['merchants'], 'unknown merchant'):
            for last4, message in (('5542', '5542 is forbidden'), ('2792', '2792 belongs to Moni')):
                for fallback in ([], ['--fallback']):
                    with self.subTest(merchant=merchant, last4=last4, fallback=fallback):
                        with patch.object(cs, 'check', side_effect=AssertionError('global refusals run first')):
                            code, out, _ = self.cli('assert-final', merchant, last4, *fallback)
                        self.assertEqual(code, 3)
                        self.assertIn(message, out)

    def test_any_route_still_refuses_cancelled_declined_or_broken_status(self):
        cs.record_cancelled('7572', reason='lost')
        cs.record_declined('2342', reason='funds')
        for last4 in ('7572', '2342'):
            self.assertEqual(self.cli('assert-final', 'openai', last4)[0], 3)
        self.path.write_text('bad')
        self.assertEqual(self.cli('assert-final', 'openai', '9546')[0], 3)

    def test_strict_routes_and_noon_fallback(self):
        for merchant, last4, flags, expected, message in (
                ('noon', '9546', [], 0, 'matches'),
                ('noon', '2342', [], 3, 'fallback requires --fallback'),
                ('noon', '2342', ['--fallback'], 0, 'matches'),
                ('uber', '2342', [], 0, 'matches'),
                ('uber', '7572', [], 3, 'expected card 2342'),
                ('uber', '7572', ['--fallback'], 3, 'expected card 2342')):
            with self.subTest(merchant=merchant, last4=last4, flags=flags):
                code, out, _ = self.cli('assert-final', merchant, last4, *flags)
                self.assertEqual(code, expected)
                self.assertIn(message, out)

    def test_repo_routes_are_valid(self):
        config = cm.routes()
        self.assertTrue(config['merchants']['openai']['any'])
        self.assertNotIn('expected', config['merchants']['openai'])
        self.assertNotIn('fallback', config['merchants']['openai'])
        for row in config['merchants'].values():
            self.assertTrue(row.get('any') is True or 'expected' in row)
            for field in ('expected', 'fallback'):
                if field in row:
                    self.assertRegex(row[field], r'^[0-9]{4}$')
                    self.assertNotIn(row[field], config['forbidden'])
        for last4 in (config['default'], *config['forbidden'], *config['other_owners']):
            self.assertRegex(last4, r'^[0-9]{4}$')

    def test_missing_or_invalid_routes_fail_closed(self):
        missing = self.path.with_name('missing-routes.json')
        invalid = [None, [], {}, {'merchants': []}]
        for field, values in {
                'default': [None, '123', 2342], 'forbidden': [None, {}, '5542', ['abcd']],
                'other_owners': [None, [], {'2792': None}, {'abc': 'Moni'}],
                'merchants': [None, [], {'openai': None}, {'openai': []},
                              {'openai': {'aliases': []}},
                              {'openai': {'any': 'true', 'aliases': []}},
                              {'openai': {'any': 1, 'aliases': []}},
                              {'openai': {'any': False, 'aliases': []}},
                              {'openai': {'any': True, 'aliases': None}},
                              {'openai': {'any': True, 'aliases': [123]}},
                              {'openai': {'expected': '5542', 'aliases': []}},
                              {'openai': {'expected': '2342', 'fallback': 'abcd', 'aliases': []}},
                              {'openai': {'expected': '2342', 'fallback': '5542', 'aliases': []}}]
                }.items():
            invalid.extend({**self.config, field: value} for value in values)
        for payload in ('bad', *[json.dumps(value) for value in invalid]):
            self.routes_path.write_text(payload)
            for merchant in ('openai', 'uber'):
                with self.subTest(payload=payload, merchant=merchant):
                    code, out, _ = self.cli('assert-final', merchant, '2342')
                    self.assertEqual(code, 3)
                    self.assertIn('checkout routes are unreadable or invalid', out)
        with patch.object(cm, 'ROUTES', missing):
            code, out, _ = self.cli('assert-final', 'openai', '2342')
            self.assertEqual(code, 3)
            self.assertIn(str(missing), out)

    def test_script_entrypoint(self):
        source = Path(cs.__file__).parent
        for name in ('card_status.py', 'card_merchants.py', 'toollog.py'):
            shutil.copyfile(source / name, self.path.parent / name)
        cmd = [sys.executable, str(self.path.with_name('card_status.py')), 'merchant', 'set', 'boat.dev', '7572']
        result = subprocess.run(cmd, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(cm.list_merchants()[0]['key'], 'boat.dev')


if __name__ == '__main__':
    unittest.main()

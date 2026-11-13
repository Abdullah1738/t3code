import contextlib
import io
import json
import os
from pathlib import Path
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
        env = patch.dict(os.environ, {'CARD_STATUS_FILE': str(self.path)})
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

    def test_script_entrypoint(self):
        cmd = [sys.executable, str(Path(cs.__file__)), 'merchant', 'set', 'boat.dev', '7572']
        result = subprocess.run(cmd, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(cm.list_merchants()[0]['key'], 'boat.dev')


if __name__ == '__main__':
    unittest.main()

"""Saved-card cases use the real CLI against isolated files, never live accounts."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import datetime as dt
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'app-api-cli'))
import card_merchants as cm
import card_status as cs

spec = importlib.util.spec_from_file_location('merchant_money_cases', Path(__file__).with_name('cases.py'))
mc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mc)


class MerchantCases(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.data = self.root / 'cases'
        # Use the interpreter explicitly, without relying on the host's shebang.
        wrapper = self.root / 'card-status'
        wrapper.write_text('#!/bin/sh\nexec ' + sys.executable + ' ' + str(Path(cs.__file__)) + ' "$@"\n')
        wrapper.chmod(0o700)
        env = patch.dict(os.environ, {'CARD_STATUS_FILE': str(self.root / 'status.json'), 'CARD_STATUS_CLI': str(wrapper),
                                     'ROBOB_TOOL_LOG_DIR': str(self.root / 'tool-logs')})
        env.start()
        self.addCleanup(env.stop)
        self.now = dt.datetime(2026, 11, 13, 9, tzinfo=mc.TZ)
        cs.record_cancelled('5542', reason='cancelled 29 Oct')
        cm.seed()

    def test_saved_card_name_does_not_abort_mixed_book_alerts(self):
        now = self.now + dt.timedelta(hours=1)
        wd = self.root / 'watch'
        wd.mkdir()
        mc.add(self.data, 'refund', 'Shop', '42', 'AED', 'refund pending', 'check receipt',
               '2026-11-13', 'Abdullah', at=self.now)
        mc.add(self.data, 'bill', 'Wio statement', '120', 'AED', 'repayment due', 'confirm paid',
               '2026-11-13', 'Abdullah', at=self.now)
        rows = [{'key': 'youtube premium', 'merchant': 'YouTube Premium', 'next_charge': '2026-11-13',
                 'dead_cards': [{'last4': '1111', 'state': 'cancelled'}]}]
        with patch.object(mc, 'merchant_dead', return_value=rows):
            event = mc.run_check(wd, 'mixed', self.data, now=now)
            # With no runner acknowledgement, none of these lines may emit again.
            repeat = mc.run_check(wd, 'mixed-again', self.data, now=now + dt.timedelta(minutes=15))
        saved = next(c for c in mc.load(self.data)['cases'] if c['kind'] == 'merchant_card')
        self.assertIn(saved['state'], event)
        self.assertIn('saved card', event)
        self.assertIn('refund: Shop AED 42', event)
        self.assertIn('bill: Wio statement AED 120', event)
        self.assertIn('balance after credits: AED 120.00', event)
        self.assertEqual(event.count('balance after credits:'), 1)
        self.assertNotIn('balance after credits:', next(line for line in event.splitlines() if saved['state'] in line))
        self.assertEqual(repeat, '')
        self.assertTrue((wd / 'pings.json').exists())

    def test_saved_card_keyword_class_is_never_a_monetary_bill(self):
        for merchant in ('YouTube Premium', 'Premium', 'Bill', 'Statement', 'Autopay', 'Repayment'):
            for amount, currency in ((None, None), ('120', 'AED')):
                with self.subTest(merchant=merchant, amount=amount, currency=currency):
                    saved = {'kind': 'merchant_card', 'merchant': merchant, 'amount': amount, 'currency': currency}
                    self.assertFalse(mc.is_bill(saved))
                    self.assertEqual(mc.balance_after_credits(saved, [saved], self.now), 'saved card')

    def test_unknown_amount_class_keeps_due_reminders_without_balance_arithmetic(self):
        for field in ('amount', 'currency'):
            for shape in ('missing', None, ''):
                with self.subTest(field=field, shape=shape):
                    data = self.root / (field + str(shape))
                    bill = mc.add(data, 'bill', 'Premium bill', '120', 'AED', 'repayment due', 'check statement',
                                  '2026-11-13', 'Abdullah', at=self.now)
                    if shape == 'missing':
                        bill.pop(field)
                    else:
                        bill[field] = shape
                    self.assertFalse(mc.is_bill(bill))
                    self.assertEqual(mc.balance_after_credits(bill, [bill], self.now), 'amount unknown')
                    entries = mc.attention([bill], self.now, {})
                    self.assertEqual(len(entries), 1)
                    self.assertIn('amount unknown', entries[0][0])
                    self.assertFalse(any('balance after credits' in text for _, text in entries[0][1]))
                    # Payment deadlines have their own alert path and must also handle an unknown amount.
                    bill['kind'] = 'payment_deadline'
                    entries = mc.payment_entries([bill], self.now, {})
                    self.assertEqual(len(entries), 1)
                    self.assertIn('amount unknown', entries[0][0])
                    self.assertIn('balance after credits: amount unknown', entries[0][1][0][1])

    def test_zero_amount_is_a_known_balance(self):
        bill = mc.add(self.data, 'zero', 'Premium bill', '0', 'AED', 'repayment due', 'check statement',
                      '2026-11-13', 'Abdullah', at=self.now)
        self.assertTrue(mc.is_bill(bill))
        self.assertEqual(mc.balance_after_credits(bill, [bill], self.now), 'AED 0.00')

    def test_open_dedupe_close_reopen_and_brief(self):
        mc.reconcile_merchants(self.data, self.now)
        original = mc.load(self.data)['cases']
        self.assertEqual(len(original), 3)
        bupa = next(c for c in original if c['merchant'] == 'Bupa')
        self.assertEqual(bupa['deadline'], '2027-01-03')
        self.assertEqual(bupa['state'], 'Bupa still holds cancelled card ••5542; next charge 2027-01-03')
        mc.reconcile_merchants(self.data, self.now + dt.timedelta(days=1))
        self.assertEqual(mc.load(self.data)['cases'], original)
        cm.set_card('boat.dev', '7572')
        mc.reconcile_merchants(self.data, self.now)
        cases = mc.load(self.data)['cases']
        self.assertEqual(sum(c['status'] == 'open' for c in cases), 2)
        self.assertEqual(next(c for c in cases if c['merchant'] == 'boat.dev')['status'], 'closed')
        self.assertIn(bupa['state'], mc.brief(cases, self.now))
        self.assertNotIn('AED 0', mc.table(cases))
        cm.set_card('boat.dev', '5542')
        mc.reconcile_merchants(self.data, self.now)
        self.assertEqual(len(mc.load(self.data)['cases']), 3)
        self.assertEqual(sum(c['status'] == 'open' for c in mc.load(self.data)['cases']), 3)

    def test_bad_or_unavailable_cli_never_closes_cases(self):
        mc.reconcile_merchants(self.data, self.now)
        before = mc.load(self.data)
        for result in ('{}', 'null', '[{}]', '[{"key":"a","merchant":"A","dead_cards":[]}]', 'not json'):
            with self.subTest(result=result), patch.object(mc.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, result)):
                with self.assertRaises(mc.CaseError):
                    mc.reconcile_merchants(self.data, self.now)
        with patch.object(mc.subprocess, 'run', side_effect=subprocess.TimeoutExpired('card-status', 4)):
            with self.assertRaises(mc.CaseError):
                mc.reconcile_merchants(self.data, self.now)
        self.assertEqual(mc.load(self.data), before)

    def test_backup_risk_one_case_per_merchant_and_owner_close_stays_closed(self):
        cm.set_card('boat.dev', '7412', role='backup')
        cs.record_declined('7412', reason='declined')
        mc.reconcile_merchants(self.data, self.now)
        cases = mc.load(self.data)['cases']
        boat = next(c for c in cases if c['merchant'] == 'boat.dev')
        self.assertIn('declined card ••7412', boat['state'])
        mc.close(self.data, boat['id'], 'owner accepts fallback', at=self.now)
        mc.reconcile_merchants(self.data, self.now)
        self.assertEqual(mc.find(mc.load(self.data), boat['id'])['status'], 'closed')
        # Other case types still work beside amountless merchant cases.
        mc.add(self.data, 'refund', 'Shop', '12', 'AED', 'refund due', 'check receipt', '2026-11-15', 'Abdullah', at=self.now)
        self.assertEqual(len(mc.load(self.data)['cases']), 4)

    def test_case_edits_do_not_reopen_unchanged_registry_risk(self):
        for field, text in (('state', 'owner accepts backup'), ('merchant', 'Boat billing'),
                            ('next', 'leave as is'), ('reference', 'owner instruction')):
            with self.subTest(field=field):
                data = self.data / field
                mc.reconcile_merchants(data, self.now)
                boat = next(c for c in mc.load(data)['cases'] if c['merchant'] == 'boat.dev')
                mc.update(data, boat['id'], {field: text}, at=self.now)
                mc.close(data, boat['id'], 'owner accepts fallback', at=self.now)
                mc.reconcile_merchants(data, self.now + dt.timedelta(days=1))
                case = mc.find(mc.load(data), boat['id'])
                self.assertEqual(case['status'], 'closed')
                self.assertEqual(case[field], text)

    def test_repeat_charge_cannot_reuse_saved_card_case(self):
        for outcome in ('card changed', 'card dead', 'changed card', 'dead card', 'card cancelled',
                        'cancelled card', 'card canceled', 'canceled card', 'card replaced', 'replaced card'):
            with self.subTest(outcome=outcome):
                data = self.data / outcome.replace(' ', '-')
                mc.reconcile_merchants(data, self.now)
                boat = next(c for c in mc.load(data)['cases'] if c['merchant'] == 'boat.dev')
                mc.close(data, boat['id'], outcome, at=self.now)
                later = self.now + dt.timedelta(days=1)
                charge = {'kind': 'charge', 'card': '7572', 'currency': 'USD', 'amount': '25', 'merchant': 'boat.dev'}
                q = mc.new_question({'questions': []}, charge, 'charge alert', later, later)
                mc.repeat_bill(data, q, later)
                self.assertIsNone(q['case'])
                self.assertEqual(q['status'], 'open')
                cm.set_card('boat.dev', '7572')
                mc.reconcile_merchants(data, later)
                self.assertEqual(mc.find(mc.load(data), boat['id'])['status'], 'closed')
                mc.case_from(data, q, later, 'check')
                mc.reconcile_merchants(data, later)
                financial = mc.find(mc.load(data), q['case'])
                self.assertEqual(financial['kind'], 'charge')
                self.assertEqual(financial['status'], 'open')
                self.assertEqual(financial['amount'], '25')
                cm.set_card('boat.dev', '5542')

    def test_missing_input_files_preserve_cases(self):
        mc.reconcile_merchants(self.data, self.now)
        before = mc.load(self.data)
        for path in (cm.merchant_path(), cs.state_path()):
            with self.subTest(path=path.name):
                retained = path.with_suffix('.retained')
                path.rename(retained)
                try:
                    with self.assertRaises(mc.CaseError):
                        mc.reconcile_merchants(self.data, self.now)
                    self.assertEqual(mc.load(self.data), before)
                finally:
                    retained.rename(path)

    def test_returning_risk_lifecycle_matrix(self):
        # Every closure origin and removal form must rearm a returning risk.
        for closed_by_owner in (False, True):
            for replacement in ('none', '7572'):
                with self.subTest(closed_by_owner=closed_by_owner, replacement=replacement):
                    data = self.data / f'{closed_by_owner}-{replacement}'
                    cm.set_card('boat.dev', '5542')
                    mc.reconcile_merchants(data, self.now)
                    boat = next(c for c in mc.load(data)['cases'] if c['merchant'] == 'boat.dev')
                    answer = mc.answered_at(boat)
                    sent = {f"{boat['id']}|ask|{answer.isoformat()}": mc.stamp(self.now)}
                    if closed_by_owner:
                        mc.close(data, boat['id'], 'owner accepts fallback', at=self.now)
                    cm.set_card('boat.dev', replacement)
                    mc.reconcile_merchants(data, self.now + dt.timedelta(days=1))
                    self.assertEqual(mc.find(mc.load(data), boat['id'])['status'], 'closed')
                    cm.set_card('boat.dev', '5542')
                    returned = self.now + dt.timedelta(days=2)
                    mc.reconcile_merchants(data, returned)
                    reopened = mc.find(mc.load(data), boat['id'])
                    self.assertEqual(reopened['status'], 'open')
                    self.assertGreater(mc.answered_at(reopened), answer)
                    self.assertTrue(mc.attention([reopened], returned, sent))

    def test_existing_check_reconciles_without_a_new_notifier(self):
        wd = self.root / 'watch'
        wd.mkdir()
        with patch.object(mc, 'follow_payments', return_value=[]), patch.object(mc, 'follow', return_value=[]):
            event = mc.run_check(wd, 'r1', self.data, now=self.now)
        self.assertEqual(len(mc.load(self.data)['cases']), 3)
        self.assertIn('boat.dev', event)
        self.assertIn('cancelled card', event)


if __name__ == '__main__':
    unittest.main()

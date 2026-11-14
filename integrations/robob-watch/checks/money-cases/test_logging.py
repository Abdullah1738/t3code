"""Case diagnostics stay outside book locks and never carry financial source text."""
import ast
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

from test_cases import Base, ALERT, BANK, at, finder, nobody, mc


HERE = Path(__file__).resolve().parent
SHARED = HERE.parents[2] / 'app-api-cli' / 'toollog.py'


class Logging(Base):
    def rows(self, name=None):
        rows = [json.loads(line) for path in (self.tmp / 'tool-logs/orders').glob('*.ndjson')
                for line in path.read_text().splitlines()]
        return [row for row in rows if name is None or row['name'] == name]

    def test_case_events_refusals_and_private_fixture_text(self):
        cid = '4242424242424242'
        self.case(cid, merchant='Secret Merchant', reference='private-reference', next_action='card ending 4242')
        mc.update(self.data, cid, {'state': 'private-state', 'deadline': '2026-11-01'},
                  reply='private-message-id', note='private-note', at=at('2026-10-25T10:00'))
        mc.corroborate(self.data, cid, 'Secret Merchant', '120.5', 'AED', '2026-10-24', 'charge', 'private-observation')
        with self.assertRaises(mc.CaseError):
            self.case('duplicate', merchant='Secret Merchant')
        with self.assertRaises(mc.CaseError):
            mc.update(self.data, cid, {'deadline': '2026-12-01'})
        with self.assertRaises(mc.CaseError):
            mc.corroborate(self.data, cid, 'Other Merchant', '120.5', 'AED', '2026-10-24', 'charge', 'private-observation')
        mc.close(self.data, cid, 'private-outcome', at=at('2026-10-26T10:00'))
        with self.assertRaises(mc.CaseError):
            mc.close(self.data, cid, 'private-outcome')
        mc.reopen(self.data, cid, '2026-12-01', 'private-note')
        with self.assertRaises(mc.CaseError):
            mc.reopen(self.data, cid, '2026-12-01', 'private-note')
        rows = self.rows()
        self.assertEqual({r['name'] for r in rows},
                         {'case.open', 'case.update', 'case.close', 'case.reopen', 'case.corroborate'})
        self.assertEqual(self.rows('case.open')[0]['props'], {'kind': 'charge', 'unmatched': False})
        self.assertEqual(self.rows('case.open')[0]['ids'],
                         {'caseId': hashlib.sha256(cid.encode()).hexdigest()[:16]})
        self.assertEqual(self.rows('case.update')[0]['props'],
                         {'fields': 'deadline,state', 'deadlineMoved': True, 'answered': True})
        self.assertEqual(self.rows('case.close')[0]['props'], {'kind': 'charge', 'ageDays': 2})
        for name, tag in [('case.open', 'CHARGE_DUPLICATE_CANDIDATE'),
                          ('case.update', 'DEADLINE_REASON_REQUIRED'),
                          ('case.corroborate', 'CORROBORATE_MISMATCH')]:
            row = next(r for r in self.rows(name) if r['kind'] == 'error')
            self.assertEqual(row['error'], {'tag': tag, 'message': tag, 'cause': {
                'httpStatus': None, 'endpoint': None, 'attempt': None, 'retryable': False,
                'upstreamCode': None, 'exceptionClass': None}})
            self.assertFalse(row['ok'])
        for private in (cid, 'Secret Merchant', 'Other Merchant', 'private-reference', 'private-state',
                        'private-note', 'private-outcome', 'private-message-id', 'private-observation', '120.50', 'AED'):
            self.assertNotIn(private, json.dumps(rows))
        self.assertNotIn('last4', json.dumps(rows))

    def test_unmatched_repeat_and_only_changed_field_names(self):
        self.case('unmatched', merchant='', unmatched=True)
        self.assertEqual(self.rows('case.open')[-1]['props'], {'kind': 'charge', 'unmatched': True})
        self.case('named', merchant='Named')
        self.case('repeat', merchant='Named', repeat='named')
        self.assertEqual(len(self.rows('case.open')), 2)
        self.assertEqual(self.rows('case.corroborate')[-1]['ok'], True)
        mc.update(self.data, 'named', {'state': 'refund asked', 'next': 'changed'}, note='note')
        self.assertEqual(self.rows('case.update')[-1]['props']['fields'], 'next')
        mc.update(self.data, 'named', {}, note='private note')
        self.assertEqual(self.rows('case.update')[-1]['props'],
                         {'fields': '', 'deadlineMoved': False, 'answered': False})

    def test_deadline_and_due_evidence_rules_are_unchanged(self):
        self.case()
        forms = [({'deadline': '2026-11-01'}, {}, False),
                 ({'deadline': '2026-11-01'}, {'because': 'reason'}, False),
                 ({'deadline': '2026-11-01'}, {'source': 'mail:fixture'}, True),
                 ({'deadline': '2026-11-02'}, {'reply': 'fixture'}, True),
                 ({'due': '2026-11-01'}, {}, False),
                 ({'due': '2026-11-01'}, {'because': 'reason'}, True)]
        for changes, evidence, accepted in forms:
            with self.subTest(changes=changes, evidence=evidence):
                if accepted:
                    mc.update(self.data, 'acme', changes, **evidence)
                    self.assertTrue(self.rows('case.update')[-1]['ok'])
                else:
                    before = (self.data / 'cases.json').read_bytes()
                    with self.assertRaises(mc.CaseError):
                        mc.update(self.data, 'acme', changes, **evidence)
                    self.assertEqual((self.data / 'cases.json').read_bytes(), before)
                    self.assertEqual(self.rows('case.update')[-1]['error']['tag'], 'DEADLINE_REASON_REQUIRED')

    def test_close_untouched_logs_only_a_new_closure(self):
        self.case()
        self.assertTrue(mc.close_untouched(self.data, 'acme', 'receipt found', at('2026-10-27T10:00')))
        self.assertTrue(mc.close_untouched(self.data, 'acme', 'receipt found', at('2026-10-27T10:00')))
        self.assertFalse(mc.close_untouched(self.data, 'missing', 'receipt found', at('2026-10-27T10:00')))
        self.assertEqual(len(self.rows('case.close')), 1)
        self.assertEqual(self.rows('case.close')[0]['props']['ageDays'], 3)

    def test_nested_ask_and_answer_emit_after_all_locks_and_writes(self):
        held, writing, seen = set(), [False], []
        enter, leave, write, emit = mc.Locked.__enter__, mc.Locked.__exit__, mc.write_json, mc.toollog.emit

        def acquire(lock):
            book = enter(lock)
            held.add(id(lock))
            return book

        def release(lock, *args):
            try:
                return leave(lock, *args)
            finally:
                held.remove(id(lock))

        def saving(*args, **kwargs):
            writing[0] = True
            try:
                return write(*args, **kwargs)
            finally:
                writing[0] = False

        def logging(*args, **kwargs):
            seen.append((bool(held), writing[0]))
            return emit(*args, **kwargs)

        now = at('2026-10-24T10:00')
        charge = mc.charges.parse(ALERT, BANK)
        with mc.Locked(self.data, 'questions') as book:
            q = mc.new_question(book, charge, ALERT, now, now)
            q['asks'] = [{'at': mc.stamp(at('2026-10-22T10:00'))}] * mc.MAX_ASKS
        with patch.object(mc.Locked, '__enter__', acquire), patch.object(mc.Locked, '__exit__', release), \
                patch.object(mc, 'write_json', saving), patch.object(mc.toollog, 'emit', logging):
            code, _ = mc.ask(self.data, 'Question?', qid=q['id'], now=now, find=finder(), said=nobody)
            self.assertEqual(code, mc.DONT_ASK)
            mc.answered(self.data, q['id'], 'private answer', now=now)
        self.assertTrue(seen)
        self.assertEqual(set(seen), {(False, False)})
        self.assertTrue(self.rows('case.open'))
        self.assertTrue(self.rows('case.update'))
        self.assertEqual(self.rows('question.ask')[-1]['props'], {'outcome': 'dont_ask'})

    def test_ask_success_source_error_and_invalid_input(self):
        now = at('2026-10-24T10:00')
        kwargs = dict(text=ALERT, sender=BANK, at=now, now=now, find=finder(), said=nobody)
        self.assertEqual(mc.ask(self.data, 'Question?', **kwargs)[0], 0)
        self.assertEqual(self.rows('question.ask')[-1]['props'], {'outcome': 'ask_now'})
        failure = {'verdict': 'ask', 'why': 'private explanation', 'errors': ['private source error']}
        with patch.object(mc, 'explain_charge', return_value=failure):
            self.assertEqual(mc.ask(self.data, 'Question?', **kwargs)[0], 4)
        self.assertEqual(self.rows('question.ask')[-1]['props'], {'outcome': 'unverified'})
        with self.assertRaises(mc.CaseError):
            mc.ask(self.data, 'Question?', text='invalid')
        self.assertEqual(self.rows('question.ask')[-1]['props'], {'outcome': 'failed'})
        self.assertNotIn('private', json.dumps(self.rows()))

    def test_check_timing_success_timeout_and_save_failure(self):
        self.case()
        now = at('2026-10-24T10:00')
        event = mc.run_check(self.wd, 'fixture', self.data, self.root, now, finder(), nobody)
        row = self.rows('check.run')[-1]
        self.assertTrue(row['ok'])
        self.assertEqual(row['props']['fired'], int(bool(event)))
        self.assertEqual(row['props']['openCases'], 1)
        timing = json.loads((self.wd / 'pings.json').read_text())['timing']
        self.assertAlmostEqual(row['durationMs'], timing['total_s'] * 1000, delta=10)
        with patch.object(mc, 'follow', side_effect=mc.CheckTimeout('fixture timeout')):
            mc.run_check(self.wd, 'timeout', self.data, self.root, now, finder(), nobody)
        self.assertFalse(self.rows('check.run')[-1]['props']['budgetHit'])
        self.assertFalse(self.rows('check.run')[-1]['ok'])
        with patch.object(mc, 'write_json', side_effect=OSError('private save failure')):
            with self.assertRaises(OSError):
                mc.run_check(self.wd, 'failure', self.data, self.root, now, finder(), nobody)
        self.assertFalse(self.rows('check.run')[-1]['ok'])
        self.assertEqual(self.rows('check.run')[-1]['props']['fired'], 0)

    def test_known_source_limits_alone_complete_ok_and_bad_reason_is_dropped(self):
        def limited(*args, stats, **kw):
            stats['question_limits'] = [{'why': 'private fixture',
                'kinds': ['ORDER_LIST_HOST_BINDING_UNVERIFIED']}]
            return []
        with patch.object(mc, 'follow', side_effect=limited):
            mc.run_check(self.wd, 'limit', self.data, self.root, at('2026-11-14T10:00'), finder(), nobody)
        row = self.rows('check.run')[-1]
        self.assertTrue(row['ok'])
        self.assertEqual(row['props']['sourceLimits'], 1)
        for bad in ('PRIVATE9999', ['PRIVATE9999'], {'private': 'PRIVATE9999'}):
            mc.toollog.emit('money-cases', 'check.run', ok=True, props={
                'orderCoverage': {'noon': {'food': {'stop_reason': bad}}}})
            row = self.rows('check.run')[-1]
            self.assertNotIn('stop_reason', row['props']['orderCoverage']['noon']['food'])
            self.assertNotIn('PRIVATE', json.dumps(row))

    def test_raising_logger_preserves_commands_and_refusals(self):
        with patch.object(mc.toollog, 'emit', side_effect=OSError('disk full')):
            self.case()
            mc.update(self.data, 'acme', {'state': 'updated'})
            mc.corroborate(self.data, 'acme', 'Acme', '120.5', 'AED', '2026-10-24', 'charge', 'SMS')
            mc.close(self.data, 'acme', 'done')
            mc.reopen(self.data, 'acme', '2026-11-01', 'needed')
            with self.assertRaisesRegex(mc.CaseError, 'deadline changes need'):
                mc.update(self.data, 'acme', {'deadline': '2026-12-01'})
            with contextlib.redirect_stdout(io.StringIO()), patch.object(mc, 'DATA', self.data):
                self.assertEqual(mc.main(['list']), 0)
            self.assertIsInstance(mc.run_check(self.wd, 'r', self.data, self.root,
                                               at('2026-10-24T10:00'), finder(), nobody), str)
            self.assertEqual(mc.ask(self.data, 'Question?', ALERT, BANK, at('2026-10-24T10:00'),
                                    now=at('2026-10-24T10:00'), find=finder(), said=nobody)[0], 0)

    def test_actual_check_budget_expiry_is_logged_without_extending_it(self):
        self.case()
        clock = [1000.0]
        def expire(*args, **kwargs):
            clock[0] += mc.CHECK_BUDGET
            raise mc.CheckTimeout('budget expired')
        self.assertEqual(mc.CHECK_BUDGET, 40)
        with patch.object(mc.time, 'time', lambda: clock[0]), patch.object(mc, 'follow', expire), \
                contextlib.redirect_stderr(io.StringIO()):
            event = mc.run_check(self.wd, 'timeout', self.data, self.root,
                                 at('2026-10-24T10:00'), finder(), nobody)
        self.assertEqual(event, '')
        row, = self.rows('check.run')
        self.assertFalse(row['ok'])
        self.assertEqual(row['durationMs'], 40000)
        self.assertEqual(row['props'], {'budgetHit': True, 'openCases': 1, 'fired': 0, 'slowestPhase': 'follow', 'sourceLimits': 0, 'limitKinds': [], 'orderCoverage': {}, 'chargeCensus': {}})

    def test_check_distinguishes_short_lock_timeout_from_work_deadline(self):
        self.case()
        now = at('2026-10-24T10:00')
        forms = [(40, 0.05, False), (1.05, 10, True)]
        with (self.data / 'cases.lock').open('a') as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            for budget, wait, budget_hit in forms:
                with self.subTest(budget=budget, lock_wait=wait):
                    def lock_cases(*args, **kwargs):
                        with mc.Locked(self.data, wait=wait):
                            self.fail('the held case lock must not be acquired')
                    with patch.object(mc, 'CHECK_BUDGET', budget), patch.object(mc, 'follow', lock_cases):
                        self.assertEqual(mc.run_check(self.wd, 'held-lock', self.data, self.root,
                                                       now, finder(), nobody), '')
                    row = self.rows('check.run')[-1]
                    self.assertEqual(row['props']['budgetHit'], budget_hit)
                    self.assertFalse(row['ok'])
                    self.assertEqual(row['props']['fired'], 0)
                    if not budget_hit:
                        self.assertIn('cases.lock still held', str(json.loads((self.wd / 'pings.json').read_text())))
        self.assertEqual(mc.CHECK_BUDGET, 40)

    def test_save_timeout_marks_budget_only_after_its_deadline(self):
        self.case()
        guard = mc.within
        for elapsed, budget_hit in ((0, False), (40, True)):
            with self.subTest(elapsed=elapsed):
                clock = [1000.0]
                @contextlib.contextmanager
                def at_save(deadline, error):
                    if deadline == 1040:
                        clock[0] += elapsed
                    with guard(deadline, error):
                        yield
                with patch.object(mc.time, 'time', lambda: clock[0]), patch.object(mc, 'within', at_save), \
                        patch.object(mc, 'write_json', side_effect=mc.CheckTimeout('local save timeout')) as write, \
                        contextlib.redirect_stderr(io.StringIO()):
                    event = mc.run_check(self.wd, 'save-timeout', self.data, self.root,
                                         at('2026-10-24T10:00'), finder(), nobody)
                self.assertEqual(event, '')
                self.assertEqual(write.call_count, 0 if budget_hit else 1)
                row = self.rows('check.run')[-1]
                self.assertEqual(row['props']['budgetHit'], budget_hit)
                self.assertFalse(row['ok'])
                self.assertEqual(row['props']['fired'], 0)
                self.assertFalse((self.wd / 'pings.json').exists())

    def test_watcher_logger_and_orders_logger_work_in_both_import_orders(self):
        helper_path = HERE.parents[1] / 'helpers/toollog.py'
        for helper_first in (True, False):
            with self.subTest(helper_first=helper_first), patch.dict(sys.modules):
                sys.modules.pop('toollog', None)
                spec = importlib.util.spec_from_file_location('toollog', helper_path)
                helper = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(helper)
                if helper_first:
                    sys.modules['toollog'] = helper
                spec = importlib.util.spec_from_file_location('import_order_cases', HERE / 'cases.py')
                loaded = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(loaded)
                if not helper_first:
                    self.assertNotIn('toollog', sys.modules)
                    sys.modules['toollog'] = helper
                self.assertIsNot(loaded.toollog, helper)
                loaded.add(self.data, 'import-' + str(helper_first).lower(), 'Shop', '1', 'AED',
                           'open', 'check', '2026-12-01', 'Abdullah', distinct=True)
                self.assertIs(sys.modules['toollog'], helper)
        self.assertEqual(len(self.rows('case.open')), 2)

    def test_slow_logger_is_bounded_and_check_watchdog_covers_the_flush(self):
        armed, seen = [False], []
        def arm(*args, **kwargs):
            armed[0] = True
        def cancel():
            armed[0] = False
        def slow(*args, **kwargs):
            seen.append(armed[0])
            time.sleep(2)
        started = time.monotonic()
        with patch.object(mc.toollog, 'emit', slow), patch.object(mc, 'run_check', return_value=''), \
                patch.object(mc, 'DATA', self.data), patch.dict(os.environ, {'WATCH_DIR': str(self.wd)}), \
                patch.object(mc.faulthandler, 'enable'), patch.object(mc.faulthandler, 'dump_traceback_later', arm), \
                patch.object(mc.faulthandler, 'cancel_dump_traceback_later', cancel):
            self.assertEqual(mc.main(['check']), 0)
        self.assertLess(time.monotonic() - started, 0.8)
        self.assertEqual(seen, [True])
        self.assertFalse(armed[0])

    def test_parent_closure_is_logged_when_the_later_question_save_fails(self):
        self.case()
        now = at('2026-10-25T10:00')
        with mc.Locked(self.data, 'questions') as book:
            q = mc.new_question(book, mc.charges.parse(ALERT, BANK), ALERT, now, now)
            q['case'] = 'acme'
        write = mc.write_json
        def fail_question(path, *args, **kwargs):
            if path.name == 'questions.json':
                raise OSError('fixture question save failed')
            return write(path, *args, **kwargs)
        with patch.object(mc, 'write_json', fail_question), self.assertRaises(OSError):
            mc.close(self.data, q['id'], 'done', at=now, source='mail:fixture')
        self.assertEqual(mc.find(mc.load(self.data), 'acme')['status'], 'closed')
        success = [r for r in self.rows('case.close') if r['ok']]
        self.assertEqual(len(success), 1)
        self.assertEqual(success[0]['ids'], {'caseId': hashlib.sha256(b'acme').hexdigest()[:16]})
        mc.close(self.data, q['id'], 'done', at=now, source='mail:fixture')
        self.assertEqual(len([r for r in self.rows('case.close') if r['ok']]), 1)

    def test_flush_does_not_swallow_an_earlier_callers_deadline(self):
        seen = []
        @mc.log_scope
        def operation():
            mc.record_event('cmd.start')
            return 'done'
        with patch.object(mc.toollog, 'emit', side_effect=lambda *a, **k: seen.append(True)):
            with mc.within(mc.time.time() + 0.1, mc.CheckTimeout('caller expired')):
                self.assertEqual(operation(), 'done')
                self.assertGreater(mc.signal.getitimer(mc.signal.ITIMER_REAL)[0], 0)
        self.assertEqual(seen, [])

    def test_no_runner_override_means_no_home_logs(self):
        with patch.dict(os.environ):
            os.environ.pop('ROBOB_TOOL_LOG_DIR', None)
            self.case()
            mc.toollog.previous_day_rollup()
            self.assertIsNone(mc.toollog.rollup())
        self.assertFalse((self.tmp / '.robob/logs').exists())

    def test_plain_read_only_process_logs_under_its_home(self):
        env = dict(os.environ, MONEY_CASES_DIR=str(self.data))
        env.pop('ROBOB_TOOL_LOG_DIR', None)
        cli = self.tmp / 'bin/money-cases'
        cli.parent.mkdir()
        cli.symlink_to(HERE / 'cases.py')
        done = subprocess.run([sys.executable, '-B', str(cli), 'list', '--json'],
                              env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(done.returncode, 0, done.stderr)
        path, = (self.tmp / '.robob/logs/tools/orders').glob('*.ndjson')
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        self.assertEqual([row['name'] for row in rows], ['cmd.start', 'cmd.end'])
        self.assertTrue(rows[-1]['ok'])
        self.assertFalse(self.data.exists())

    def test_shared_copy_parity_shapes_directory_guards_and_rollup(self):
        self.assertEqual((HERE / 'toollog.py').read_bytes(), SHARED.read_bytes())
        spec = importlib.util.spec_from_file_location('shared_orders_toollog', SHARED)
        shared = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(shared)
        for log in (shared, mc.toollog):
            self.assertEqual(log.log_dir(), self.tmp / 'tool-logs')
            log.emit('money-cases', 'case.open', ids={'caseId': 'fixture'}, ok=True,
                     props={'kind': 'charge', 'unmatched': False})
        first, second = self.rows()
        self.assertEqual({k: v for k, v in first.items() if k != 'ts'},
                         {k: v for k, v in second.items() if k != 'ts'})
        with patch.dict(os.environ):
            os.environ.pop('ROBOB_TOOL_LOG_DIR', None)
            self.assertIsNone(shared.log_dir())
            self.assertIsNone(mc.toollog.log_dir())
        self.assertEqual(shared.rollup()['countsByName']['case.open'], 2)
        for log in (shared, mc.toollog):
            for name in ('case.open', 'case.update', 'question.ask', 'check.run'):
                log.emit('money-cases', name, ids={'orderId': 'private', 'caseId': 'fixture'},
                         props={'merchant': 'noon', 'amountMinor': 1234, 'last4': '4242', 'currency': 'AED',
                                'state': 'placed', 'note': 'private', 'outcome': 'private',
                                'fields': 'state,private'})
        self.assertNotIn('private', json.dumps(self.rows()))
        self.assertNotIn('amountMinor', json.dumps(self.rows()))
        self.assertNotIn('last4', json.dumps(self.rows()))

    def test_order_coverage_and_source_limit_logs_drop_private_fields(self):
        mc.toollog.emit('money-cases', 'check.run', ok=True, props={
            'sourceLimits': 2, 'limitKinds': ['food_page_1', 'PRIVATE9999'],
            'chargeCensus': {'noon': {'open': 5, 'matched': 1, 'proven_clean': 1, 'limited': 2,
                'error': 1, 'not_checked': 1, 'PRIVATE9999': 7}, 'PRIVATE9999': {'open': 1}},
            'orderCoverage': {'noon': {'food': {'covered_from': '2026-11-10T12:00:00+00:00',
                'pages': 1, 'fetched': 3, 'cached': 2, 'ms': 1000, 'exhaustive': False,
                'limit': 'page-1 history only', 'stop_reason': 'detail_error', 'coverage_cleared_rows': 2,
                'address': 'PRIVATE9999', 'card': '9999'}},
                'PRIVATE9999': {'food': {'covered_from': 'PRIVATE9999'}}},
            'card': '9999', 'address': 'PRIVATE9999'})
        run, = self.rows('check.run')
        self.assertEqual(run['props']['sourceLimits'], 2)
        self.assertEqual(run['props']['chargeCensus'], {'noon': {'open': 5, 'matched': 1,
            'proven_clean': 1, 'limited': 2, 'error': 1, 'not_checked': 1}})
        self.assertEqual(run['props']['limitKinds'], ['food_page_1'])
        lane = run['props']['orderCoverage']['noon']['food']
        self.assertEqual(lane['covered_from'], '2026-11-10T12:00:00+00:00')
        self.assertEqual((lane['fetched'], lane['cached']), (3, 2))
        self.assertEqual(lane['stop_reason'], 'detail_error')
        self.assertEqual(lane['coverage_cleared_rows'], 2)
        self.assertNotIn('PRIVATE', json.dumps(run))
        self.assertNotIn('9999', json.dumps(run))

    def test_production_modules_never_import_test_runners(self):
        for path in HERE.glob('*.py'):
            if path.name.startswith('test_'):
                continue
            for node in ast.walk(ast.parse(path.read_text())):
                modules = [a.name for a in node.names] if isinstance(node, ast.Import) else \
                    [node.module or ''] if isinstance(node, ast.ImportFrom) else []
                self.assertFalse(any(name.split('.')[0] in ('unittest', 'pytest') for name in modules), path.name)


if __name__ == '__main__':
    unittest.main()

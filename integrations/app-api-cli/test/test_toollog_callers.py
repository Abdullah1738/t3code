"""Caller attribution and pagination use synthetic transports and private logs."""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import toollog as log
import noon_http_orders as noon
import noon_vertical_reads as vertical
import test_order_history_coverage as history
import amazon_email_orders as amazon
import amazon_dia_cli as browser_cli
import test_amazon_browser_orders as browser
from test_amazon_dia_cli import payload
from test_amazon_email_orders import NOW


class Callers(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        env = patch.dict(os.environ, ROBOB_TOOL_LOG_DIR=str(self.root), TOOLLOG_ROOT=str(self.root),
                         ORDERS_LOG_CALLER='', ORDERS_LOG_TRIGGER='', ORDERS_LOG_RUN_ID='', WATCH_RUN='')
        env.start()
        self.addCleanup(env.stop)

    def rows(self):
        return [json.loads(line) for file in (self.root / 'orders').glob('*.ndjson')
                for line in file.read_text().splitlines()]

    def test_every_provider_event_has_context_on_success_and_failure(self):
        for component, name in [('noon', 'provider.orders'), ('noon', 'provider.details'),
                                ('noon', 'provider.track'), ('amazon', 'provider.orders'),
                                ('amazon', 'provider.track'), ('careem', 'provider.track')]:
            for fail in (False, True):
                @log.timed(component, name)
                def provider():
                    if fail:
                        raise ValueError('private address')
                    return {'ok': True}
                with log.caller_context('money-cases', run_id='private-run-id'):
                    with self.assertRaises(ValueError) if fail else contextlib.nullcontext():
                        provider()
                props = self.rows()[-1]['props']
                self.assertEqual(props['caller'], 'money-cases')
                self.assertEqual(props['trigger'], 'run:' + hashlib.sha256(b'private-run-id').hexdigest()[:16])
        log.emit('noon', 'provider.details')
        self.assertEqual(self.rows()[-1]['props']['caller'], 'other')
        self.assertEqual(self.rows()[-1]['props']['trigger'], 'other')
        self.assertNotIn('private', json.dumps(self.rows()))

    def test_context_restores_and_crosses_process_boundary(self):
        with log.caller_context('delivery-card', command='delivery-card'):
            with log.caller_context('order-watch', command='status'):
                env = log.caller_env()
                app = str(Path(log.__file__).parent)
                code = "import sys; sys.path.insert(0, sys.argv[1]); import toollog; toollog.emit('noon','provider.track')"
                result = subprocess.run([sys.executable, '-I', '-B', '-c', code, app],
                                        env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.rows()[0]['props']['caller'], 'delivery-card')
        log.emit('noon', 'provider.track')
        self.assertEqual(self.rows()[-1]['props']['caller'], 'other')

    def test_entrypoints_and_commerce_command_supply_context(self):
        @log.entrypoint('order-watch', 'status', cli=True)
        def entry(argv):
            log.emit('noon', 'provider.track')
        entry(['check-pending', '--order', 'private-order'])
        self.assertEqual(self.rows()[-1]['props']['trigger'], 'check-pending')
        with patch.dict(os.environ, WATCH_RUN='private-run'):
            entry(['check'])
        self.assertRegex(self.rows()[-1]['props']['trigger'], '^run:[a-f0-9]{16}$')
        def execute(args):
            log.emit('noon', 'provider.details')
            return 0
        log.run_command(SimpleNamespace(command='order-details'), execute)
        row = [r for r in self.rows() if r['name'] == 'provider.details'][-1]
        self.assertEqual((row['props']['caller'], row['props']['trigger']), ('commerce-cmd', 'order-details'))

    def test_money_cases_reader_logs_survive_subprocess(self):
        source = Path(log.__file__).parents[1] / 'robob-watch/checks/money-cases/order_lookup.py'
        # Careem's deliberate list refusal requires no credentials or network.
        result = subprocess.run([sys.executable, '-I', '-B', str(source), 'careem',
                                 str(Path(log.__file__).parent), '9999999999'],
                                input='{}', capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        row, = self.rows()
        self.assertEqual(row['props']['caller'], 'money-cases')
        self.assertEqual(row['props']['trigger'], 'order-lookup')
        self.assertFalse(row['ok'])

    def test_money_cases_read_keeps_the_configured_log_destination(self):
        source = Path(log.__file__).parents[1] / 'robob-watch/checks/money-cases'
        spec = importlib.util.spec_from_file_location('caller_lookup', source / 'order_lookup.py')
        lookup = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(lookup)
        with patch.object(sys, 'path', [str(source), *sys.path]), patch.dict(os.environ,
                MONEY_CASES_APP_API=str(Path(log.__file__).parent), MONEY_CASES_ORDER_PYTHON=sys.executable):
            with self.assertRaises(lookup.SourceLimit):
                lookup.read('careem', cache_path=self.root / 'details.json')
        row, = self.rows()
        self.assertEqual(row['props']['caller'], 'money-cases')

    def test_run_trigger_survives_exec_and_fork_without_raw_id(self):
        app = str(Path(log.__file__).parent)
        code = ("import sys,multiprocessing; sys.path.insert(0,sys.argv[1]); import toollog; "
                "p=multiprocessing.get_context('fork').Process(target=lambda: toollog.emit('noon','provider.track')); "
                "p.start(); p.join(); sys.exit(p.exitcode)")
        with log.caller_context('order-watch', run_id='private-run'):
            result = subprocess.run([sys.executable, '-I', '-B', '-c', code, app], env=log.caller_env(),
                                    capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        row, = self.rows()
        self.assertEqual(row['props']['trigger'], 'run:' + hashlib.sha256(b'private-run').hexdigest()[:16])
        self.assertNotIn('private-run', json.dumps(row))

    def test_new_fields_never_carry_free_text(self):
        private = ['4242424242424242', '+971501234567', 'AED 99.50', 'Apartment 987',
                   'NORDER1234', 'cookie=value', 'check --order NORDER1234',
                   'run:4242424242424242', ['private'], {'private': 'secret'}, True, 1.5, -1]
        for value in private:
            safe = log._fields(dict(caller=value, trigger=value, pagesFetched=value, rowsReturned=value))
            self.assertEqual(safe, {})
            with patch.dict(os.environ, ORDERS_LOG_CALLER=str(value), ORDERS_LOG_TRIGGER=str(value)):
                log.emit('noon', 'provider.orders', props={'caller': value, 'trigger': value})
            with log.caller_context('commerce-cmd', command=value):
                log.emit('noon', 'provider.orders')
        for row in self.rows():
            self.assertIn(row['props']['caller'], ('other', 'commerce-cmd'))
            self.assertEqual(row['props']['trigger'], 'other')
        for caller in log._ENUMS['caller']:
            for trigger in log._TRIGGERS:
                self.assertEqual(log._fields(dict(caller=caller, trigger=trigger)),
                                 dict(caller=caller, trigger=trigger))

    def test_page_counts_include_replayed_and_empty_pages_and_partial_failure(self):
        forms = [
            ('marketplace', 2, [history.History.page('NTEST1', True, 'next'), history.History.page('NTEST2', False, None)], 2, 2),
            ('marketplace', 1, [{'data': []}, {'data': [], 'pagination': {'hasMore': False}}], 2, 0),
            ('all', 1, [{'orders': []}, noon.NoonError('private'), noon.NoonError('private')], 1, 0),
        ]
        for service, page, responses, pages, rows in forms:
            with self.subTest(service=service, pages=pages), patch.object(noon, 'verified_session', return_value={}), \
                    patch.object(noon, 'request', side_effect=responses):
                noon.orders(service, page=page)
                props = self.rows()[-1]['props']
                self.assertEqual((props['pagesFetched'], props['rowsReturned']), (pages, rows))
        for lane in ('food', 'nownow'):
            with patch.object(vertical, '_headers', return_value={}), \
                    patch.object(vertical, '_read', return_value={'status': 'success', 'data': {'orders': [], 'pages': 1}}):
                getattr(vertical, lane + '_orders')(page=1)
                props = self.rows()[-1]['props']
                self.assertEqual((props['pagesFetched'], props['rowsReturned']), (1, 0))
        with self.assertRaises(noon.NoonError):
            noon.orders(page=-1)
        props = self.rows()[-1]['props']
        self.assertEqual((props['pagesFetched'], props['rowsReturned']), (0, 0))

    def test_amazon_page_counts_distinguish_all_search_outcome_forms(self):
        account = amazon.ACCOUNTS[0]
        hit = {'account': account, 'folder': 'Fixture', 'uid': 1, 'subject': 'Unrecognized fixture'}
        success = {'status': {account: {'ok': True}}, 'hits': []}
        partial = {'status': {account: {'ok': False, 'error': 'private timeout'}}, 'hits': [hit]}
        forms = [
            ('missing executable', FileNotFoundError('private path'), 0, 0, 0),
            ('OS failure', OSError('private path'), 0, 0, 0),
            ('deadline', subprocess.TimeoutExpired(['private'], 1), 0, 0, 0),
            ('failed command without response', '', 1, 0, 0),
            ('invalid JSON', 'private non-json', 0, 0, 0),
            ('non-object response', [], 0, 0, 0),
            ('missing hits', {'status': {}}, 0, 0, 0),
            ('invalid hits', {'status': {}, 'hits': {}}, 0, 0, 0),
            ('missing status', {'hits': []}, 0, 0, 0),
            ('empty page', success, 0, 1, 0),
            ('populated page', {**success, 'hits': [hit]}, 0, 1, 1),
            ('partial response with failure', partial, 1, 1, 1),
            ('all accounts failed without rows', {**partial, 'hits': []}, 1, 0, 0),
        ]
        for name, response, returncode, pages, rows in forms:
            with self.subTest(form=name):
                def runner(*args, **kwargs):
                    if isinstance(response, Exception):
                        raise response
                    stdout = response if type(response) is str else json.dumps(response)
                    return subprocess.CompletedProcess(args, returncode, stdout, '')
                amazon.orders(accounts=[account], runner=runner, now=NOW)
                props = self.rows()[-1]['props']
                self.assertEqual((props['pagesFetched'], props['rowsReturned']), (pages, rows))
        self.assertNotIn('private', json.dumps(self.rows()))

    def test_noon_counts_only_list_shaped_source_pages(self):
        forms = [('missing', None, False), ('null', None, True), ('object', {}, True),
                 ('string', 'private', True), ('boolean', True, True), ('number', 1, True),
                 ('empty list', [], True), ('malformed list row', [None], True)]
        for lane in ('minutes', 'marketplace', 'food', 'nownow'):
            key = 'data' if lane == 'marketplace' else 'orders'
            for form, value, present in forms:
                data = {key: value} if present else {}
                if lane == 'marketplace':
                    data['pagination'] = {'hasMore': False}
                if lane in ('food', 'nownow'):
                    data = {'status': 'success', 'data': {**data, 'pages': 1}}
                with self.subTest(lane=lane, form=form), \
                        patch.object(noon, 'verified_session', return_value={}), \
                        patch.object(noon, 'request', return_value=data), \
                        patch.object(vertical, '_headers', return_value={}), \
                        patch.object(vertical, '_read', return_value=data):
                    try:
                        if lane in ('minutes', 'marketplace'):
                            noon.orders(lane, page=2, **({'cursor': 'fixture-cursor'} if lane == 'marketplace' else {}))
                        else:
                            getattr(vertical, lane + '_orders')(page=1)
                    except noon.NoonError:
                        pass
                    props = [row for row in self.rows() if row['name'] == 'provider.orders'][-1]['props']
                    self.assertEqual((props['pagesFetched'], props['rowsReturned']),
                                     (1, len(value)) if isinstance(value, list) else (0, 0))
        self.assertNotIn('private', json.dumps(self.rows()))

    def test_amazon_browser_counts_accepted_page_before_exact_order_filter(self):
        page = browser.snapshot([browser.order(browser.OID), browser.order(browser.OTHER)])
        details = browser.snapshot(kind='details', path='/your-orders/order-details')
        missing = '123-0000000-0000000'
        forms = [
            ('unfiltered history', page, None, None, 1, 2),
            ('first match', page, browser.OID, None, 1, 2),
            ('second match', page, browser.OTHER, None, 1, 2),
            ('missing history target', page, missing, 'ORDER_NOT_ON_THIS_PAGE', 1, 2),
            ('matching detail', details, browser.OID, None, 1, 1),
            ('missing detail target', details, missing, 'ORDER_NOT_ON_THIS_PAGE', 1, 1),
            ('empty page', browser.snapshot([]), None, 'NO_SUPPORTED_ORDER_CARDS', 0, 0),
            ('duplicate IDs', browser.snapshot([browser.order(), browser.order()]), None, 'DUPLICATE_ORDER_ID', 0, 0),
            ('unsupported schema', browser.snapshot(schema='private'), None, 'UNSUPPORTED_SCHEMA', 0, 0),
            ('challenge', browser.snapshot(challenge=True), None, 'AUTH_OR_CHALLENGE_REQUIRED', 0, 0),
        ]
        for name, snapshot, target, error, pages, rows in forms:
            response = browser.dia(snapshot)
            response['target']['url'] = snapshot['origin'] + snapshot['path']
            with self.subTest(form=name), patch.object(browser_cli.shutil, 'which', return_value='/fixture/node'), \
                    patch.object(browser_cli, '_bounded_process', return_value=payload(response)):
                with self.assertRaisesRegex(browser_cli.BrowserOrdersError, '^' + error + '$') if error else contextlib.nullcontext():
                    result = browser_cli.read_orders(expected_order_id=target)
                    self.assertEqual(len(result['orders']), 1 if target else 2)
                props = [row for row in self.rows() if row['name'] == 'provider.orders'][-1]['props']
                self.assertEqual((props['pagesFetched'], props['rowsReturned']), (pages, rows))
        self.assertNotIn('private', json.dumps(self.rows()))

    def test_rollup_splits_provider_counts_and_percentiles_without_mixing_components(self):
        for caller, component, duration in [('money-cases', 'noon', 1), ('money-cases', 'noon', 3),
                                            ('order-watch', 'noon', 100), ('order-watch', 'amazon', 200)]:
            with log.caller_context(caller, command='check'):
                log.emit(component, 'provider.orders', kind='perf', duration_ms=duration, ok=True)
        # Historical rows without attribution belong to other, never a guessed caller.
        with next((self.root / 'orders').glob('*.ndjson')).open('a') as stream:
            stream.write(json.dumps({'name': 'provider.orders', 'component': 'noon', 'kind': 'perf', 'durationMs': 7}) + '\n')
        log.emit('order-watch', 'track.poll', duration_ms=9999)
        summary = log.rollup()
        self.assertEqual(summary['countsByCaller'], {'money-cases': 2, 'order-watch': 2, 'other': 1})
        self.assertEqual(summary['durationsMs']['noon:provider.orders']['byCaller'], {
            'money-cases': {'count': 2, 'p50': 1, 'p95': 3, 'max': 3},
            'order-watch': {'count': 1, 'p50': 100, 'p95': 100, 'max': 100},
            'other': {'count': 1, 'p50': 7, 'p95': 7, 'max': 7}})
        self.assertEqual(summary['durationsMs']['provider.orders']['byCaller']['order-watch']['p95'], 200)
        self.assertNotIn('byCaller', summary['durationsMs']['track.poll'])

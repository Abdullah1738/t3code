"""Diagnostics fixtures never use credentials, network, or the real log directory."""
import datetime as dt
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error

import toollog as log


class CauseLogs(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name) / 'tools' / 'orders'
        env = patch.dict(os.environ, {'ROBOB_TOOL_LOG_DIR': str(self.folder.parent)})
        env.start()
        self.addCleanup(env.stop)
        log._SEEN.clear()

    def lines(self):
        return ''.join(p.read_text() for p in self.folder.glob('*.ndjson'))

    def rows(self):
        return [json.loads(line) for line in self.lines().splitlines()]

    def test_noon_details_http_and_timeout_keep_original_cause_and_request_count(self):
        import noon_order_details as details
        import noon_vertical_reads as vertical
        secrets = ['private-token-value', 'private-cookie-value', '4242424242424242',
                   'Apartment 987 Example Street', '+971501234567', '846291']
        for status in (401, 500, None):
            with self.subTest(status=status):
                exc = (urllib.error.HTTPError('https://user:private-token-value@example.invalid/path?otp=846291',
                        status, ' '.join(secrets), {'Authorization': secrets[0], 'Set-Cookie': secrets[1]},
                        io.BytesIO(json.dumps({'error': {'code': 'TOKEN_EXPIRED'}, 'private': secrets}).encode()))
                       if status else TimeoutError(' '.join(secrets)))
                opener = SimpleNamespace(open=unittest.mock.Mock(side_effect=exc))
                with patch.object(vertical, '_headers', return_value={'authorization': secrets[0]}), \
                        patch.object(vertical.urllib.request, 'build_opener', return_value=opener):
                    with self.assertRaises(details.core.NoonError):
                        details.details('FTEST', 'food')
                opener.open.assert_called_once()
                row = self.rows()[-1]
                self.assertEqual(row['props'], {'merchant': 'noon', 'lane': 'food'})
                self.assertEqual(row['error']['cause'], {
                    'httpStatus': status, 'endpoint': '/_svc/mp-food-api-mpnoon/order/details',
                    'attempt': 1, 'retryable': status != 401, 'upstreamCode': None,
                    'exceptionClass': 'HTTPError' if status else 'TimeoutError'})
                self.assertLessEqual(len(row['error']['message']), 200)
        for value in secrets:
            self.assertNotIn(value, self.lines())

    def test_already_decoded_careem_error_code_survives_without_private_body(self):
        import careem_http_orders as careem
        auth = careem.auth
        secrets = ['SECRET_BEARER_VALUE', 'secret-cookie', '4242424242424242',
                   'Apartment 987 Example Street', '+971501234567', '846291']
        saved = {'auth': {'access_token': secrets[0]}, 'identity': {'phone_number': secrets[4]},
                 'client': {'headers': {'cookie': secrets[1]}}}
        for status, code in ((401, 'TOKEN_EXPIRED'), (500, 'INTERNAL_SERVER_ERROR')):
            with self.subTest(status=status):
                response = urllib.error.HTTPError('https://example.invalid/?otp=846291', status,
                    ' '.join(secrets), {'Set-Cookie': secrets[1]}, io.BytesIO(json.dumps({
                        'error': {'code': code, 'message': ' '.join(secrets)}, 'private': secrets}).encode()))
                opener = SimpleNamespace(open=unittest.mock.Mock(side_effect=response))
                with patch.object(auth, 'account', return_value=saved), \
                        patch.object(auth, 'verify_customer'), \
                        patch.object(auth.urllib.request, 'build_opener', return_value=opener):
                    with self.assertRaises(careem.CareemError):
                        careem.track('846291')
                opener.open.assert_called_once()
                row = self.rows()[-1]
                self.assertEqual(row['props']['merchant'], 'careem')
                cause = row['error']['cause']
                self.assertEqual(cause, {'httpStatus': status, 'endpoint': '/v1/activity-tracker/food/:id',
                    'attempt': 1, 'retryable': status == 500, 'upstreamCode': code,
                    'exceptionClass': 'CareemError'})
                self.assertEqual(row['error']['message'], f'HTTP {status}: {code}')
        for value in secrets:
            self.assertNotIn(value, self.lines())

    def test_noon_200_schema_failures_keep_request_metadata_and_safe_reason(self):
        import noon_order_details as details
        import noon_vertical_reads as vertical
        forms = [
            ({}, 'SCHEMA_CHANGED'),
            ([], 'SCHEMA_CHANGED'),
            ({'status': 'success', 'data': {}}, 'ORDER_MISMATCH_OR_SCHEMA_CHANGED'),
            ({'status': 'success', 'data': {'orderNr': 'FTEST', 'items': [
                {'itemCode': 'FIXTURE', 'qty': 0}]}}, 'ORDER_ITEM_SCHEMA_CHANGED'),
        ]
        for body, reason in forms:
            with self.subTest(reason=reason, body=body):
                response = unittest.mock.MagicMock(code=200)
                response.__enter__.return_value = response
                response.read.return_value = json.dumps(body).encode()
                opener = SimpleNamespace(open=unittest.mock.Mock(return_value=response))
                with patch.object(vertical, '_headers', return_value={'authorization': 'private-token'}), \
                        patch.object(vertical.urllib.request, 'build_opener', return_value=opener):
                    with self.assertRaisesRegex(details.core.NoonError, '^' + reason + '$'):
                        details.details('FTEST', 'food')
                opener.open.assert_called_once()
                response.read.assert_called_once()
                row = self.rows()[-1]
                self.assertEqual(row['error']['cause'], {
                    'httpStatus': 200, 'endpoint': '/_svc/mp-food-api-mpnoon/order/details',
                    'attempt': 1, 'retryable': False, 'upstreamCode': None,
                    'exceptionClass': 'NoonError'})
                self.assertEqual(row['error']['message'], 'HTTP 200: ' + reason)
        self.assertNotIn('private-token', self.lines())

    def test_amazon_result_failures_reach_actual_tracker_error_and_poll(self):
        import amazon_email_orders as amazon
        import order_tracker as tracker
        from test_amazon_email_orders import OID
        folder = self.folder.parent / 'watcher'
        folder.mkdir(parents=True)
        now = tracker.time.time()
        cfg = {'app': 'amazon', 'order': OID, 'watcher': 'fixture', 'for': 'owner', 'eta': None,
               'placed_at': tracker.stamp(now - 3600), 'registered_at': tracker.stamp(now)}
        forms = [('timeout private-token', 'account_timeout'),
                 ('private-token unavailable', 'account_unavailable'),
                 ('', 'account_unavailable')]
        for source_error, code in forms:
            with self.subTest(code=code, source_error=source_error):
                tracker.write(folder / 'order-tracker-state.json', {'primed': True, 'status': 'unknown'})
                payload = {'hits': [], 'status': {
                    account: {'ok': False, 'error': source_error} for account in amazon.ACCOUNTS}}
                runner = unittest.mock.Mock(return_value=SimpleNamespace(
                    returncode=0, stdout=json.dumps(payload)))
                start = len(self.rows())
                with patch.dict(os.environ, {'WATCH_DIR': str(folder)}), \
                        patch.object(amazon.subprocess, 'run', runner), \
                        patch.object(tracker.store, 'evidence', return_value=([], [])), \
                        contextlib.redirect_stdout(io.StringIO()):
                    tracker.check(cfg)
                runner.assert_called_once()
                rows = {row['name']: row for row in self.rows()[start:]}
                self.assertTrue({'provider.track', 'track.error', 'track.poll'} <= rows.keys())
                for name in ('provider.track', 'track.error', 'track.poll'):
                    row = rows[name]
                    self.assertEqual(row['props']['merchant'], 'amazon')
                    self.assertEqual(row['error']['cause']['upstreamCode'], code)
                    self.assertEqual(row['error']['message'], code)
                state = tracker.read(folder / 'order-tracker-state.json')
                self.assertEqual(state['status'], 'unknown')
                self.assertEqual(state['last_result']['errors'], ['amazon_' + code] * len(amazon.ACCOUNTS))
        self.assertNotIn('private-token', self.lines())

    def test_result_error_shapes_keep_observed_request_and_reach_parent(self):
        forms = [
            {'ok': False, 'error': 'ACCOUNT_TIMEOUT'},
            {'ok': False, 'error': {'code': 'ACCOUNT_TIMEOUT', 'message': 'private-token'}},
            {'errors': ['ACCOUNT_TIMEOUT']},
            {'errors': [{'code': 'ACCOUNT_TIMEOUT', 'message': 'private-token'}]},
            {'ok': False, 'code': 'ACCOUNT_TIMEOUT'},
            {'ok': False, 'errorCode': 'ACCOUNT_TIMEOUT'},
            {'ok': False, 'error_code': 'ACCOUNT_TIMEOUT'},
        ]
        for result in forms:
            with self.subTest(result=result):
                @log.timed('amazon', 'provider.track')
                def provider():
                    with log.request('/userinfo'):
                        log.response(200, {})
                    return result
                @log.timed('order-watch', 'track.poll')
                def poll(cfg):
                    provider_result = provider()
                    log.emit('order-watch', 'track.error', kind='error', error='TRACK_POLL_SOURCE_ERROR')
                    return provider_result
                start = len(self.rows())
                poll({'app': 'amazon'})
                for row in self.rows()[start:]:
                    self.assertEqual(row['error']['cause']['httpStatus'], 200)
                    self.assertEqual(row['error']['cause']['endpoint'], '/userinfo')
                    self.assertEqual(row['error']['cause']['attempt'], 1)
                    self.assertEqual(row['error']['cause']['upstreamCode'], 'ACCOUNT_TIMEOUT')
                    self.assertEqual(row['error']['message'], 'HTTP 200: ACCOUNT_TIMEOUT')
        self.assertNotIn('private-token', self.lines())

    def test_careem_live_and_fallback_polls_keep_merchant_and_fetch_phases(self):
        import native_orders
        import order_tracker as tracker
        now = tracker.time.time()
        folder = self.folder.parent / 'watcher'
        folder.mkdir(parents=True)
        cfg = {'app': 'careem', 'order': '123456', 'watcher': 'fixture', 'for': 'owner',
               'placed_at': tracker.stamp(now - 600), 'registered_at': tracker.stamp(now),
               'eta': None, 'label': 'Fixture Cafe: Private item', 'vertical': 'food'}
        forms = [('food', True, [], 'out for delivery'),
                 ('food', True, ['notification_collector_stale'], 'out for delivery'),
                 ('quik', True, [], 'out for delivery'),
                 ('box', True, [], 'unknown'), ('food', False, [], 'unknown')]
        for vertical, single, errors, expected in forms:
            with self.subTest(vertical=vertical, single=single, errors=errors):
                tracker.write(folder / 'order-tracker-state.json', {'primed': True, 'status': 'unknown'})
                text = 'Careem Quik 5 minutes' if vertical == 'quik' else 'Fixture Cafe 5 minutes'
                ticks = [0]
                def clock():
                    ticks[0] += .5
                    return ticks[0]
                start = len(self.rows())
                with patch.dict(os.environ, {'WATCH_DIR': str(folder)}), \
                        patch.object(tracker, 'ROOT', folder / 'orders-root'), \
                        patch.object(tracker, 'single_allowed', return_value=single), \
                        patch('native_orders.track', side_effect=native_orders.OrderError('AUTH_EXPIRED')), \
                        patch.object(tracker, 'mail_evidence', return_value=([], [])), \
                        patch.object(tracker.store, 'rows', return_value=([
                            {'posted': now - 1, 'detected': now, 'text': text}], errors)) as live, \
                        patch.object(tracker.store, 'evidence', return_value=([], [])) as fallback, \
                        patch.object(log, 'perf_counter', side_effect=clock), \
                        contextlib.redirect_stdout(io.StringIO()):
                    tracker.check({**cfg, 'vertical': vertical})
                state = tracker.read(folder / 'order-tracker-state.json')
                self.assertEqual(state['status'], expected)
                live_path = vertical != 'box' and single
                self.assertEqual(live.call_count, int(live_path))
                self.assertEqual(fallback.call_count, int(not live_path))
                self.assertEqual(bool(state['last_result'].get('live_source_ok')), live_path and not errors)
                rows = self.rows()[start:]
                self.assertTrue({'track.error', 'track.poll'} <= {r['name'] for r in rows})
                for row in rows:
                    self.assertEqual(row['props']['merchant'], 'careem')
                    self.assertEqual(row['props']['lane'], vertical)
                poll = next(r for r in rows if r['name'] == 'track.poll')
                self.assertGreater(poll['props']['phases']['fetchMs'], 0)
                self.assertAlmostEqual(sum(poll['props']['phases'].values()), poll['durationMs'])
        self.assertNotIn('Private item', self.lines())
        self.assertNotIn('Fixture Cafe', self.lines())

    def test_timeout_forms_are_retryable_and_have_a_safe_message(self):
        import noon_http_orders
        import noon_minutes_checkout
        import careem_account_auth
        import amazon_dia_cli
        forms = [
            (TimeoutError('private timeout'), 'TimeoutError'),
            (subprocess.TimeoutExpired(['private command'], 1), 'TimeoutExpired'),
            (urllib.error.URLError(TimeoutError('private timeout')), 'TimeoutError'),
            (noon_http_orders.NoonError('NATIVE_READ_TIMEOUT'), 'NoonError'),
            (noon_minutes_checkout.MinutesError('REQUEST_TIMEOUT'), 'MinutesError'),
            (careem_account_auth.AccountError('HTTP_TIMEOUT'), 'AccountError'),
            (amazon_dia_cli.BrowserOrdersError('DIA_TIMEOUT'), 'BrowserOrdersError'),
        ]
        for exc, cls in forms:
            with self.subTest(cls=cls):
                log.emit('order-watch', 'track.error', kind='error', error=exc)
                row = self.rows()[-1]
                self.assertEqual(row['error']['cause']['exceptionClass'], cls)
                self.assertTrue(row['error']['cause']['retryable'])
                self.assertEqual(row['error']['message'], 'Upstream request timed out')
        self.assertNotIn('private', self.lines())

    def test_real_careem_deadline_guard_is_observed_before_network(self):
        import careem_account_auth as auth
        @log.timed('careem', 'provider.track')
        def read():
            return auth._transport('GET', 'https://identity.careem.com/userinfo', {}, None, False, 0)
        with patch.object(auth.urllib.request, 'build_opener') as opener:
            with self.assertRaisesRegex(auth.AccountError, '^HTTP_TIMEOUT$'):
                read()
        opener.return_value.open.assert_not_called()
        self.assertEqual(self.rows()[-1]['error']['cause'], {
            'httpStatus': None, 'endpoint': '/userinfo', 'attempt': 1, 'retryable': True,
            'upstreamCode': None, 'exceptionClass': 'AccountError'})
        self.assertEqual(self.rows()[-1]['error']['message'], 'Upstream request timed out')

    def test_redaction_input_classes(self):
        endpoints = [
            ('https://user:password@example.invalid/_svc/order-v2/order/4242424242424242?token=secret#otp',
             '/_svc/order-v2/order/:id'),
            ('/_svc/mp-food-api-mpnoon/order/tracking/food/info?cookie=secret',
             '/_svc/mp-food-api-mpnoon/order/tracking/:id/info'),
            ('/_svc/mp-shop-api-mpnoon/v1/order/tracking/%34%32%34%32',
             '/_svc/mp-shop-api-mpnoon/v1/order/tracking/:id'),
            ('/secret-cookie/private-address', '/:redacted'),
            ('/_svc/instant/order/get?otp=846291', '/_svc/instant/order/get'),
        ]
        for raw, expected in endpoints:
            with self.subTest(raw=raw):
                self.assertEqual(log._endpoint(raw), expected)
        codes = [('TOKEN_EXPIRED', 'TOKEN_EXPIRED'), ('internal_server_error', 'internal_server_error'),
                 ('AUTH_EXPIRED\nsecret', None), ('SECRET_BEARER_VALUE', None),
                 ('4242424242424242', None), ('Apartment 987 Example Street', None),
                 ('AUTH_' * 20, None), ('invalid_token', 'invalid_token')]
        for raw, expected in codes:
            with self.subTest(code=raw):
                self.assertEqual(log._upstream_code(raw), expected)
        log.emit('noon', 'provider.details', kind='error', error='SECRET_BEARER_VALUE', cause={
            'httpStatus': 500, 'endpoint': endpoints[0][0], 'attempt': 2,
            'retryable': True, 'upstreamCode': 'SECRET_BEARER_VALUE',
            'exceptionClass': 'SECRET_BEARER_VALUE', 'reason': 'SECRET_BEARER_VALUE',
            'body': '4242424242424242'})
        self.assertNotIn('SECRET_BEARER_VALUE', self.lines())
        self.assertNotIn('4242424242424242', self.lines())
        self.assertEqual(self.rows()[0]['error']['cause']['attempt'], 2)

    def test_all_provider_and_tracker_events_include_merchant(self):
        for name in sorted(log._NAMES):
            if name.startswith(('provider.', 'track.')):
                for kind in ('event', 'perf', 'error'):
                    log.emit('order-watch', name, kind=kind, props={'merchant': 'unsupported'},
                             error='FAILED' if kind == 'error' else None)
        @log.timed('order-watch', 'track.poll')
        def check(cfg):
            for name in ('track.error', 'track.transition', 'track.delivered', 'track.eta_elapsed'):
                log.emit('order-watch', name, error='TRACK_POLL_SOURCE_ERROR')
            return {'ok': False}
        check({'app': 'noon', 'vertical': 'minutes'})
        for row in self.rows():
            self.assertIn(row['props']['merchant'], {'unknown', 'noon'})
        for row in self.rows()[-5:]:
            self.assertEqual(row['props']['merchant'], 'noon')
            self.assertEqual(row['props']['lane'], 'minutes')

    def test_registration_failure_cli_forms_keep_known_merchant_and_lane(self):
        forms = [
            (['--app', 'noon', '--vertical', 'food'], 'noon', 'food'),
            (['--app=noon', '--vertical=minutes'], 'noon', 'minutes'),
            (['--app', 'noon', '--vertical=main'], 'noon', 'main'),
            (['--app=careem', '--vertical', 'quik'], 'careem', 'quik'),
            (['--app=careem', '--vertical=shops'], 'careem', 'shops'),
            (['--app=careem', '--vertical=box'], 'careem', 'box'),
            (['--app=amazon', '--vertical=same-day'], 'amazon', 'same-day'),
            (['--app=noon', '--vertical=food', '--vertical', 'supermall'], 'noon', 'supermall'),
            (['--app=not-supported', '--vertical=private-value'], 'unknown', None),
            ([], 'unknown', None),
        ]
        @log.registration
        def register(argv=None, _locked=False):
            raise ValueError('private failure')
        for args, merchant, lane in forms:
            with self.subTest(args=args), self.assertRaises(ValueError):
                register(['add', *args])
            row = self.rows()[-1]
            self.assertEqual(row['props']['merchant'], merchant)
            self.assertEqual(row['props'].get('lane'), lane)
        for order, lane in [('FTEST', 'food'), ('NNTEST', 'nownow'), ('NTEST', 'marketplace'), ('ITEST', 'minutes')]:
            log.emit('order-watch', 'track.add', ids={'orderId': order}, props={'merchant': 'noon'})
            self.assertEqual(self.rows()[-1]['props']['lane'], lane)
        self.assertNotIn('private', self.lines())

    def test_rollup_groups_cause_and_keeps_legacy_percentiles(self):
        for merchant, status, duration in [('noon', 401, 10), ('noon', 401, 20),
                                           ('noon', 500, 30), ('amazon', 500, 5000),
                                           ('unknown', None, 40)]:
            log.emit('order-watch', 'track.poll', kind='error', ok=False, duration_ms=duration,
                     props={'merchant': merchant}, error='OPERATION_FAILED',
                     cause=log._cause(status=status))
        summary = log.rollup()
        groups = {(r['tag'], r['httpStatus'], r['merchant']): r['count'] for r in summary['topErrors']}
        self.assertEqual(groups, {('OPERATION_FAILED', 401, 'noon'): 2,
            ('OPERATION_FAILED', 500, 'noon'): 1, ('OPERATION_FAILED', 500, 'amazon'): 1,
            ('OPERATION_FAILED', None, 'unknown'): 1})
        timing = summary['durationsMs']['track.poll']
        self.assertEqual((timing['p50'], timing['p95'], timing['max']), (30, 5000, 5000))
        self.assertEqual(timing['byMerchant']['noon'], {'count': 3, 'p50': 20, 'p95': 30, 'max': 30})
        self.assertEqual(timing['byMerchant']['amazon']['count'], 1)
        self.assertEqual(summary, json.loads(next(self.folder.glob('rollup-*.json')).read_text()))

    def test_phase_wall_time_does_not_double_count_parallel_reads(self):
        scope = {'intervals': [(1, 8, 'parse'), (2, 5, 'fetch'), (3, 7, 'fetch'), (4, 6, 'parse')]}
        self.assertEqual(log._phases(scope, 0, 10), {'fetchMs': 5000, 'parseMs': 2000, 'otherMs': 3000})

    def test_amazon_workers_record_email_fetch_and_parse_and_result_is_unchanged(self):
        import amazon_email_orders as amazon
        from test_amazon_email_orders import confirmation, OID, NOW
        lock, ticks = threading.Lock(), [0.0]
        def clock():
            with lock:
                ticks[0] += .01
                return ticks[0]
        calls = []
        def runner(args, **kwargs):
            calls.append(args)
            if args[1] == 'read':
                return SimpleNamespace(returncode=0, stdout=confirmation().decode())
            return SimpleNamespace(returncode=0, stdout=json.dumps({
                'hits': [{'account': 'gmail', 'folder': 'INBOX', 'uid': 1,
                          'subject': 'Ordered: Fixture', 'folder_total': 1}],
                'status': {'gmail': {'ok': True}}}))
        @log.timed('order-watch', 'track.poll')
        def poll(cfg):
            return amazon.track(OID, runner=runner, accounts=['gmail'], now=NOW)
        with patch.object(log, 'perf_counter', side_effect=clock):
            result = poll({'app': 'amazon'})
        self.assertFalse(result['errors'])
        self.assertEqual(result['status'], 'confirmed')
        self.assertEqual(len(calls), 2)
        row = self.rows()[-1]
        phases = row['props']['phases']
        self.assertGreater(phases['fetchMs'], 0)
        self.assertGreater(phases['parseMs'], 0)
        self.assertAlmostEqual(sum(phases.values()), row['durationMs'], places=2)

    def test_slow_and_failed_polls_include_phases_and_context(self):
        for merchant, duration, expected in [('noon', 3, True), ('careem', 1, False), ('amazon', 1, True)]:
            with self.subTest(merchant=merchant):
                @log.timed('order-watch', 'track.poll')
                def poll(cfg):
                    raise TimeoutError('private-exception-message')
                with patch.object(log, 'perf_counter', side_effect=[0, duration]):
                    with self.assertRaises(TimeoutError):
                        poll({'app': merchant})
                row = self.rows()[-1]
                self.assertEqual('phases' in row['props'], expected)
                if expected:
                    self.assertEqual(row['props']['phases'], {'fetchMs': 0, 'parseMs': 0, 'otherMs': duration*1000})
        self.assertNotIn('private-exception-message', self.lines())

    def test_amazon_caught_search_timeout_keeps_cause_without_command_or_output(self):
        import amazon_email_orders as amazon
        from test_amazon_email_orders import OID, NOW
        secret = 'private-command-and-mail-output'
        runner = unittest.mock.Mock(side_effect=subprocess.TimeoutExpired(
            ['mailsearch', secret], 1, output=secret, stderr=secret))
        result = amazon.track(OID, runner=runner, accounts=['gmail'], now=NOW)
        self.assertTrue(result['errors'])
        runner.assert_called_once()
        cause = self.rows()[-1]['error']['cause']
        self.assertGreaterEqual(cause.pop('phaseElapsedMs'), 0)
        self.assertEqual(cause, {
            'httpStatus': None, 'endpoint': '/amazon/mail/search', 'attempt': 1, 'retryable': True,
            'upstreamCode': None, 'exceptionClass': 'TimeoutExpired', 'phase': 'order_list'})
        self.assertNotIn(secret, self.lines())

    def test_structured_source_error_uses_safe_code_as_message(self):
        @log.timed('amazon', 'provider.track')
        def track():
            return {'errors': [{'code': 'account_unavailable', 'message': 'private-token'}]}
        track()
        self.assertEqual(self.rows()[-1]['error']['message'], 'account_unavailable')
        self.assertNotIn('private-token', self.lines())

    def test_legacy_rollup_is_upgraded_even_when_source_size_matches(self):
        self.folder.mkdir(parents=True)
        day = '2026-11-12'
        path = self.folder / ('rollup-' + day + '.json')
        path.write_text(json.dumps({'sourceBytes': 0}))
        now = dt.datetime(2026, 11, 13, 1, tzinfo=dt.timezone.utc)
        class Clock:
            @staticmethod
            def now(tz):
                return now
        with patch.object(log.dt, 'datetime', Clock):
            log.previous_day_rollup()
        self.assertEqual(json.loads(path.read_text())['schemaVersion'], 2)

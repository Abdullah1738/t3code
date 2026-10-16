import base64
import copy
import http.client as http_client
import http.server as http_server
import json
import signal
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import talabat_http_orders as http
import native_orders
import order_tracker
import talabat_auth as auth


def saved(exp=None):
    payload = base64.urlsafe_b64encode(json.dumps({'exp': exp or time.time() + 500}).encode()).decode().rstrip('=')
    return {'auth': {'access_token': 'test.' + payload + '.test', 'customerId': 7},
            'account_verified': True, 'country': 'AE',
            'expected_profile': {'id': 7, 'mobile_country_code': '971', 'mobile_number': '500000000'}, 'headers': {}}


def screen(order='123', status='order_delivered'):
    return {'type': 'OrderTrackingScreen', 'common_tracking_event_attributes': {
        'order_id': order, 'delivery_status': status}, 'widgets': {'private': 'secret'}}


def active_screen(status='order_delivering', title='Arrives in 10 mins'):
    """Sanitized live component shape, synthetic identity/name, no raw fixture."""
    data = screen(status=status)
    data['common_tracking_event_attributes'].update(eta_lower='10/08/2026 14:50:20', eta_upper='10/08/2026 15:01:24')
    data['layouts'] = [{'name': 'body', 'column': ['header_with_lifecycle_order_component', 'tlb_app_bff_passthrough']}]
    data['widgets'] = {
        'header_with_lifecycle_order_component': {'type': 'Stack', 'data': {'children': [
            {'type': 'Map', 'data': {'pins': [{'latitude': 'private'}]}},
            {'type': 'FluidComponent', 'data': {'component': {'properties': {'order_container': {'properties': {
                'title_offstage': False, 'cells': [{'template_id': 'active-order-item-v2', 'properties': {
                    'tracking_key': '123', 'title': title, 'sub_title': 'Your order is on the way'}}]}}}},
                'templates': {'private': 'must not inspect'}}}]}},
        'tlb_app_bff_passthrough': {'type': 'FluidComponent', 'data': {'component': {'properties': {'children': [
            {'template_id': 'rider_info', 'properties': {'title': 'Test Rider', 'text': 'is your delivery hero for today',
                'has_text': True, 'has_contact_bottom_sheet': True, 'has_trailing_widget': True,
                'contact_bottom_sheet': {'properties': {'phone': 'private', 'url': 'private'}}}}]}},
            'templates': {'private': 'must not inspect'}}}}
    return data


class TalabatHttpTest(unittest.TestCase):
    def setUp(self):
        # Offline ownership evidence for the existing tracking/renewal tests.
        # Missing/partial/error history cases have their own regression module.
        listing = patch('talabat_http_list.page_request', return_value={
            'orders': [{'id': '123', 'status': 'Delivered'}],
            'is_last_page': True, 'total_orders': 1})
        listing.start()
        self.addCleanup(listing.stop)

    def test_confirming_variants_are_pre_preparing_not_terminal(self):
        for raw in ('order_confirming', 'order_confirmingdelayed'):
            with self.subTest(raw=raw):
                result = http.project(active_screen(raw), '123')
                self.assertEqual(result['status'], 'pending confirmation')
                self.assertNotIn(result['status'], order_tracker.TERMINAL)
                self.assertEqual(result['raw_status'], raw)
                self.assertEqual(result['status_source'], 'common_tracking_event_attributes.delivery_status')
                self.assertIsNone(result['rider'])
                self.assertIsNone(result['eta_text'])

    def test_confirming_tracker_does_not_fallback_or_wake_tracking_problem(self):
        s, now = saved(), 10000
        cfg = {'app': 'talabat', 'order': '123', 'registered_at': order_tracker.stamp(now - 60)}
        for raw in ('order_confirming', 'order_confirmingdelayed'):
            state = {'primed': True, 'status': 'unknown', 'tracking_problem_streak': 3}
            with self.subTest(raw=raw), patch.object(http, 'load', return_value=s), \
                    patch.object(http, 'request', side_effect=lambda path, *_:
                                 s['expected_profile'] if path == http.PROFILE else screen(status=raw)), \
                    patch.object(order_tracker, 'talabat_receipt', side_effect=AssertionError('no receipt fallback')), \
                    patch.object(order_tracker, 'mail_evidence', side_effect=AssertionError('no mail fallback')), \
                    patch.object(order_tracker.store, 'evidence', side_effect=AssertionError('no push fallback')), \
                    patch.object(order_tracker, 'run', side_effect=AssertionError('no phone')):
                for tick in range(4):
                    result = order_tracker.fetch(cfg, state, now + tick * 60)
                    events = order_tracker.transition(result, state, cfg, now + tick * 60)
                    self.assertEqual(result['status'], 'pending confirmation')
                    self.assertEqual(result['raw_status'], raw)
                    self.assertEqual(result['errors'], [])
                    self.assertEqual(events, [])
                    self.assertEqual(state['tracking_problem_streak'], 0)

    def test_commerce_exact_tracking_confirming_variants_are_read_only(self):
        import commerce_cli
        s = saved()
        for vertical in ('shops', 'mart', 'restaurants'):
            for raw in ('order_confirming', 'order_confirmingdelayed'):
                with self.subTest(vertical=vertical, raw=raw), patch.object(http, 'load', return_value=s), \
                        patch.object(http, 'request', side_effect=[s['expected_profile'], screen(status=raw)]) as request, \
                        patch.object(commerce_cli.talabat, '_wire', side_effect=AssertionError('no checkout transport')), \
                        patch.object(commerce_cli.journal, 'consume', side_effect=AssertionError('no financial sends')):
                    result = commerce_cli.track_exact('talabat', vertical, '123')
                self.assertEqual(result['status'], 'pending confirmation')
                self.assertEqual(result['raw_status'], raw)
                self.assertEqual([c.args[0] for c in request.call_args_list], [http.PROFILE, http.TRACKING + '123'])

    def test_nearby_requires_exact_visible_subtitle_and_delivering_enum(self):
        data = active_screen(title='Arrives within 5 mins')
        cell = data['widgets']['header_with_lifecycle_order_component']['data']['children'][1]['data']['component']['properties']['order_container']['properties']['cells'][0]['properties']
        cell['sub_title'] = 'Your order is nearby'
        result = http.project(data, '123')
        self.assertEqual(result['status'], 'nearby')
        self.assertEqual(result['raw_status'], 'order_delivering')
        self.assertTrue(result['status_source'].endswith('.sub_title'))
        self.assertEqual(result['rider']['name'], 'Test Rider')
        data['common_tracking_event_attributes']['delivery_status'] = 'unknown_state'
        self.assertEqual(http.project(data, '123')['status'], 'unknown')
        data['common_tracking_event_attributes']['delivery_status'] = 'order_delivering'
        cell['tracking_key'] = '456'
        result = http.project(data, '123')
        self.assertEqual(result['status'], 'out for delivery')
        self.assertIsNone(result['rider'])

    def test_live_active_projection_display_eta_not_naive_timestamp(self):
        for raw, stage, title in [('order_almostready', 'preparing', 'Arrives in 10-20 mins'),
                                  ('order_delivering', 'out for delivery', 'Arrives in 10 mins'),
                                  ('order_delivering', 'out for delivery', 'Arrives within 5 mins')]:
            result = http.project(active_screen(raw, title), '123')
            self.assertEqual(result['status'], stage)
            self.assertEqual(result['eta_text'], title)
            self.assertTrue(result['eta_source'].endswith('cells[0].properties.title'))
            self.assertIsNone(result['eta'])
            self.assertEqual(result['rider']['name'], 'Test Rider')
            self.assertNotIn('private', json.dumps(result))
            self.assertNotIn('14:50:20', json.dumps(result))

    def test_hidden_absent_ambiguous_active_cells_never_fallback_to_rider(self):
        for mode in ['absent', 'wrong_order', 'hidden', 'offstage', 'duplicate', 'unreferenced', 'templates_only']:
            data = active_screen()
            header = data['widgets']['header_with_lifecycle_order_component']
            component = header['data']['children'][1]['data']['component']
            container = component['properties']['order_container']['properties']
            cell = container['cells'][0]
            if mode == 'absent': container['cells'] = []
            elif mode == 'wrong_order': cell['properties']['tracking_key'] = '456'
            elif mode == 'hidden': cell['properties']['hidden'] = True
            elif mode == 'offstage': container['title_offstage'] = True
            elif mode == 'duplicate': container['cells'].append(copy.deepcopy(cell))
            elif mode == 'unreferenced': data['layouts'][0]['column'].remove('header_with_lifecycle_order_component')
            else:
                header['data']['children'][1]['data']['templates'] = component
                header['data']['children'][1]['data']['component'] = {}
            result = http.project(data, '123')
            self.assertIsNone(result['eta_text'], mode)
            self.assertIsNone(result['rider'], mode)

    def test_rider_requires_actual_component_visibility_not_events(self):
        for mode in ['missing', 'wrong_template', 'hidden', 'false_policy', 'missing_contact', 'past_tense', 'duplicate', 'unreferenced']:
            with self.subTest(mode=mode):
                data = active_screen()
                widget = data['widgets']['tlb_app_bff_passthrough']
                children = widget['data']['component']['properties']['children']
                if mode == 'missing': children.clear()
                elif mode == 'wrong_template': children[0]['template_id'] = 'unverified_rider'
                elif mode == 'hidden': children[0]['properties']['offstage'] = True
                elif mode == 'false_policy': children[0]['properties']['showRiderDetails'] = False
                elif mode == 'missing_contact': children[0]['properties']['has_contact_bottom_sheet'] = False
                elif mode == 'past_tense': children[0]['properties']['text'] = 'was your delivery hero for today'
                elif mode == 'duplicate': children.append(copy.deepcopy(children[0]))
                else: data['layouts'][0]['column'].remove('tlb_app_bff_passthrough')
                data['common_tracking_event_attributes']['rider'] = 'private'
                self.assertIsNone(http.project(data, '123')['rider'])

    def test_conflicting_cell_or_header_at_index_30_is_not_hidden_by_scan_bound(self):
        for mode in ['cells', 'header_children']:
            with self.subTest(mode=mode):
                data = active_screen()
                children = data['widgets']['header_with_lifecycle_order_component']['data']['children']
                cells = children[1]['data']['component']['properties']['order_container']['properties']['cells']
                target = cells if mode == 'cells' else children
                duplicate = copy.deepcopy(cells[0] if mode == 'cells' else children[1])
                target.extend({} for _ in range(30 - len(target)))
                target.append(duplicate)
                result = http.project(data, '123')
                self.assertIsNone(result['eta_text'])
                self.assertIsNone(result['rider'])

    def test_conflicting_rider_at_index_30_is_not_hidden_by_scan_bound(self):
        data = active_screen()
        children = data['widgets']['tlb_app_bff_passthrough']['data']['component']['properties']['children']
        duplicate = copy.deepcopy(children[0])
        duplicate['properties']['title'] = 'Another Rider'
        children.extend({} for _ in range(29))
        children.append(duplicate)
        self.assertIsNone(http.project(data, '123')['rider'])

    def test_terminal_unknown_and_malformed_widgets_do_not_expose_rider(self):
        for raw in ['order_delivered', 'order_cancelled', 'brand_new_state']:
            result = http.project(active_screen(raw), '123')
            self.assertIsNone(result['rider'])
            self.assertIsNone(result['eta_text'])
        for malformed in [None, [], 'not a dict']:
            data = active_screen()
            data['widgets']['header_with_lifecycle_order_component']['data'] = malformed
            self.assertIsNone(http.project(data, '123')['rider'])

    def test_expiry_renews_once_before_any_get(self):
        old, new = saved(time.time() - 1), saved()
        with patch.object(http, 'load', side_effect=[old, new]), \
                patch.object(http, 'request', side_effect=[new['expected_profile'], screen()]) as request, \
                patch.object(auth, 'refresh') as refresh:
            self.assertEqual(http.track('123')['status'], 'delivered')
        refresh.assert_called_once()
        self.assertEqual(refresh.call_args.kwargs['rejected_token'], old['auth']['access_token'])
        self.assertEqual(request.call_count, 2)

    def test_401_profile_or_tracking_restarts_full_read_once(self):
        s = saved()
        error = http.TalabatError('AUTH_EXPIRED_RENEWAL_REQUIRED')
        for replies, paths in [([error, s['expected_profile'], screen()], [http.PROFILE, http.PROFILE, http.TRACKING + '123']),
                               ([s['expected_profile'], error, s['expected_profile'], screen()],
                                [http.PROFILE, http.TRACKING + '123', http.PROFILE, http.TRACKING + '123'])]:
            with patch.object(http, 'load', return_value=s), patch.object(http, 'request', side_effect=replies) as request, \
                    patch.object(auth, 'refresh') as refresh:
                self.assertEqual(http.track('123')['status'], 'delivered')
            self.assertEqual([c.args[0] for c in request.call_args_list], paths)
            self.assertEqual(len({c.args[2] for c in request.call_args_list}), 1)
            refresh.assert_called_once()
            self.assertEqual(refresh.call_args.kwargs['deadline'], request.call_args.args[2])

    def test_second_401_no_second_refresh_and_never_otp(self):
        with patch.object(http, 'load', return_value=saved()), \
                patch.object(http, 'request', side_effect=http.TalabatError('AUTH_EXPIRED_RENEWAL_REQUIRED')) as request, \
                patch.object(auth, 'refresh') as refresh, patch.object(auth, 'login_request') as otp:
            with self.assertRaisesRegex(http.TalabatError, 'EXPIRED'):
                http.track('123')
        self.assertEqual(request.call_count, 2)
        refresh.assert_called_once()
        otp.assert_not_called()

    def test_other_failures_never_renew(self):
        for error in ['AUTH_FORBIDDEN', 'RATE_LIMITED', 'SCHEMA_CHANGED', 'ACCOUNT_IDENTITY_MISMATCH']:
            with patch.object(http, 'load', return_value=saved()), patch.object(http, 'request', side_effect=http.TalabatError(error)), \
                    patch.object(auth, 'refresh') as refresh:
                with self.assertRaisesRegex(http.TalabatError, error): http.track('123')
            refresh.assert_not_called()

    def test_refresh_uses_remaining_budget_and_late_completion_no_read_retry(self):
        clock = [0.0]
        def request(*args):
            clock[0] = 3.0
            raise http.TalabatError('AUTH_EXPIRED_RENEWAL_REQUIRED')
        def refresh(**kwargs):
            self.assertEqual(kwargs['timeout'], 2.0)
            self.assertEqual(kwargs['deadline'], 5.0)
            clock[0] = 5.1
        with patch.object(http.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(http, 'load', return_value=saved()), patch.object(http, 'request', side_effect=request) as get, \
                patch.object(auth, 'refresh', side_effect=refresh):
            with self.assertRaisesRegex(http.TalabatError, 'NATIVE_READ_TIMEOUT'): http.track('123', timeout=5)
        get.assert_called_once()

    def test_invalid_timeout_precedes_storage(self):
        with patch.object(http, 'load') as load:
            for timeout in [0, -1, float('nan'), float('inf'), True, '1', 121]:
                with self.assertRaisesRegex(http.TalabatError, 'INVALID_TIMEOUT'): http.track('123', timeout=timeout)
        load.assert_not_called()

    def test_deadline_guard_never_overwrites_caller_timer_or_thread(self):
        for timer, current in [((10.0, 0.0), threading.main_thread()),
                               ((0.0, 0.0), object())]:
            with patch.object(http.signal, 'getitimer', return_value=timer), \
                 patch.object(http.signal, 'signal') as handler, \
                 patch.object(http.signal, 'setitimer') as arm, \
                 patch.object(http.threading, 'current_thread', return_value=current):
                with self.assertRaisesRegex(http.TalabatError, 'NATIVE_DEADLINE_UNAVAILABLE'):
                    with http.read_deadline(time.monotonic() + 1):
                        self.fail('unbounded read permitted')
                handler.assert_not_called()
                arm.assert_not_called()

    def test_truncated_profile_response_preserves_tracker_fallback(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.side_effect = http_client.IncompleteRead(b'private partial body', 10)
        opener = Mock()
        opener.open.return_value = response
        with patch.object(http, 'load', return_value=saved()), \
             patch.object(http.urllib.request, 'build_opener', return_value=opener), \
             patch.object(order_tracker, 'talabat_receipt', return_value=(None, [])) as receipt, \
             patch.object(order_tracker, 'mail_evidence', return_value=([], [])) as mail, \
             patch.object(order_tracker.store, 'evidence', return_value=([], [])) as pushes, \
             patch.object(order_tracker, 'single_allowed', return_value=False):
            result = order_tracker.fetch({'app': 'talabat', 'order': '123'}, {}, 1000)
        self.assertEqual(result['status'], 'unknown')
        self.assertIn('native_native_read_failed', result['errors'])
        self.assertNotIn('private', json.dumps(result))
        receipt.assert_called_once()
        mail.assert_called_once()
        pushes.assert_called_once()
        response.__exit__.assert_called_once()

    def test_completion_after_deadline_is_rejected(self):
        s, clock = saved(), [0.0]
        responses = []
        for data, finished_at in [(s['expected_profile'], 1), (screen(), 20)]:
            response = Mock()
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            def read_body(_size, data=data, finished_at=finished_at):
                clock[0] = finished_at
                return json.dumps(data).encode()
            response.read.side_effect = read_body
            responses.append(response)
        opener = Mock()
        opener.open.side_effect = responses
        with patch.object(http, 'load', return_value=s), \
             patch.object(http.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(http.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(native_orders.OrderError, 'NATIVE_READ_TIMEOUT'):
                native_orders.track('talabat', '123', timeout=8)

    def test_drip_body_and_headers_have_elapsed_time_deadline(self):
        # Real local HTTP sockets, no Keychain/external network. Socket-operation
        # timeouts alone accept this because bytes arrive every 20 ms.
        for mode in ['body', 'headers']:
            stop = threading.Event()
            class Drip(http_server.BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def do_GET(self):
                    content = json.dumps(saved()['expected_profile']).encode()
                    if mode == 'body':
                        self.send_response(200)
                        self.send_header('Content-Length', str(len(content)))
                        self.end_headers()
                        stream = content
                    else:
                        stream = b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}'
                    for byte in stream:
                        if stop.wait(0.02):
                            break
                        try:
                            self.wfile.write(bytes([byte]))
                            self.wfile.flush()
                        except OSError:
                            break
            server = http_server.ThreadingHTTPServer(('127.0.0.1', 0), Drip)
            server.daemon_threads = True
            worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
            worker.start()
            old_handler = signal.getsignal(signal.SIGALRM)
            try:
                with patch.object(http, 'load', return_value=saved()), \
                     patch.object(http, 'HOST', f'http://127.0.0.1:{server.server_port}'):
                    start = time.monotonic()
                    with self.assertRaisesRegex(native_orders.OrderError, 'NATIVE_READ_TIMEOUT'):
                        native_orders.track('talabat', '123', timeout=0.15)
                    self.assertLess(time.monotonic() - start, 0.75)
                self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
                self.assertEqual(signal.getsignal(signal.SIGALRM), old_handler)
            finally:
                stop.set()
                server.shutdown()
                server.server_close()
                worker.join(timeout=1)

    def test_projection_exact_identity_and_no_private_fields(self):
        result = http.project(screen(), '123')
        self.assertEqual(result['status'], 'delivered')
        self.assertEqual(result['source'], 'native_order_api')
        self.assertIsNone(result['eta'])
        self.assertIsNone(result['rider'])
        self.assertNotIn('secret', json.dumps(result))
        with self.assertRaisesRegex(http.TalabatError, 'MISMATCH'):
            http.project(screen('456'), '123')

    def test_unknown_states_fail_closed(self):
        for status in ['order_placed', 'delivery_expected', 'order_cancelled', 'order_confirming_new_state']:
            self.assertEqual(http.project(screen(status=status), '123')['status'], 'unknown')
        with self.assertRaises(http.TalabatError):
            http.project({'common_tracking_event_attributes': screen()['common_tracking_event_attributes']}, '123')

    def test_account_required_expiry_and_binding(self):
        with patch.object(http, 'load', return_value=None), patch.object(http, 'request') as request:
            with self.assertRaisesRegex(http.TalabatError, 'CAPTURE_REQUIRED'):
                http.track('123')
            request.assert_not_called()
        with patch.object(http, 'load', return_value=saved(time.time() - 1)):
            with self.assertRaisesRegex(http.TalabatError, 'EXPIRED'):
                http.account()
        s = saved()
        s['auth']['customerId'] = 8
        with patch.object(http, 'load', return_value=s):
            with self.assertRaisesRegex(http.TalabatError, 'MISMATCH'):
                http.account()

    def test_live_profile_mismatch_prevents_tracking(self):
        with patch.object(http, 'load', return_value=saved()), patch.object(http, 'request', return_value={'id': 8}) as request:
            with self.assertRaisesRegex(http.TalabatError, 'MISMATCH'):
                http.track('123')
            self.assertEqual(request.call_count, 1)

    def test_corrupt_storage_fails_closed(self):
        cases = [['bad'], {'auth': ['bad']}, saved(float('inf'))]
        missing = saved()
        missing['expected_profile']['id'] = None
        missing['auth']['customerId'] = None
        cases.append(missing)
        for value in cases:
            with patch.object(http, 'load', return_value=value), patch.object(http, 'request') as request:
                with self.assertRaises(http.TalabatError):
                    http.track('123')
                request.assert_not_called()

    def test_cli_dispatch_and_tracker_skip_fallback(self):
        s = saved()
        with patch.object(http, 'load', return_value=s), patch.object(http, 'request', side_effect=[s['expected_profile'], screen()]), \
             patch.object(order_tracker, 'mail_evidence') as mail, patch.object(order_tracker, 'run') as adb:
            result = order_tracker.fetch({'app': 'talabat', 'order': '123'}, {}, 100)
        self.assertEqual(result['status'], 'delivered')
        self.assertEqual(result['evidence'][0]['source'], 'native_order_api')
        mail.assert_not_called()
        adb.assert_not_called()

    def test_invalid_id_and_mutations_never_requested(self):
        with patch.object(http, 'load') as load:
            for order in ['../123', 'abc', '123?x=1', '', '1' * 21]:
                with self.assertRaises(http.TalabatError):
                    http.track(order)
            load.assert_not_called()
        with patch.object(http.urllib.request, 'build_opener') as opener:
            with self.assertRaisesRegex(http.TalabatError, 'ENDPOINT_DENIED'):
                http.request('/checkout', saved(), time.monotonic() + 5)
            opener.assert_not_called()

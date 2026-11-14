"""Replay the existing transport fixtures and verify observable diagnostic coverage."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


class LaneLogs(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        env = patch.dict(os.environ, {'ROBOB_TOOL_LOG_DIR': str(self.base)})
        env.start()
        self.addCleanup(env.stop)

    def replay(self, name):
        with tempfile.TemporaryDirectory(dir=self.base) as temp, patch.dict(os.environ,{'ROBOB_TOOL_LOG_DIR':temp}):
            suite=unittest.defaultTestLoader.loadTestsFromName(name)
            result=unittest.TestResult()
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                suite.run(result)
            self.assertEqual(result.errors+result.failures,[],name)
            rows = [json.loads(line) for p in (Path(temp)/'orders').glob('*.ndjson') for line in p.read_text().splitlines()]
            for row in rows:
                if row['name'].startswith(('provider.', 'track.')):
                    self.assertIn(row['props']['merchant'], {'noon', 'careem', 'amazon', 'uber', 'other', 'unknown'})
            return rows

    def test_lane_success_and_refusal_diagnostics(self):
        cases=[
            ('minutes','test_commerce_minutes.OrderMinutesEndToEndTests.test_order_minutes_cvv_basket_prepares_places_and_pays',
             'test_commerce_minutes.MinutesIntegrationTests.test_existing_cart_cannot_be_replaced','step.cart_build'),
            ('main','test_commerce_main_order.LaneTests.test_full_lane_order_and_bodies',
             'test_commerce_main_order.LaneTests.test_silent_delivery_inactive_refused_before_place','step.checkout'),
            ('supermall','test_commerce_supermall_order.LaneTests.test_full_lane_order_and_bodies',
             'test_commerce_supermall_order.LaneTests.test_silent_delivery_inactive_refused_before_place','step.checkout'),
            ('nownow','test_commerce_nownow_order.LaneTests.test_full_lane_order_and_single_quiet_call',
             'test_commerce_nownow_order.LaneTests.test_fresh_readback_missing_quiet_note_blocks_place','step.checkout'),
            ('food','test_noon_food_financial.FoodFinancialTests.test_automatic_bank_capture_completes_without_payment_send',
             'test_noon_food_financial.FoodFinancialTests.test_default_transport_refuses_before_reads_or_journal','step.payment_submit'),
        ]
        for lane, success, failure, event in cases:
            with self.subTest(lane=lane):
                rows=self.replay(success)
                self.assertTrue(any(r['name']=='step.payment_submit' and r.get('ok') for r in rows))
                self.assertIn('payment.may_have_sent',[r['name'] for r in rows])
                rows=self.replay(failure)
                self.assertTrue(any(r['name']==event and r.get('ok') is False for r in rows), rows)

    def test_registration_success_and_failure_fixtures(self):
        rows=self.replay('test_order_watch_notice.AddNoticeTests.test_slow_first_check_still_sends_and_registers')
        added=[r for r in rows if r['name']=='track.add']
        self.assertEqual([r['ok'] for r in added],[True,False])
        self.assertEqual(added[0]['props']['source'],'cli')

    def test_other_noon_lanes_keep_address_and_quiet_guard_tags(self):
        cases=[
            ('test_commerce_main_order.LaneTests.test_address_binding_mismatch_refused',
             'MAIN_ADDRESS_BINDING_MISMATCH'),
            ('test_commerce_supermall_order.LaneTests.test_address_binding_mismatch_refused',
             'SUPERMALL_ADDRESS_BINDING_MISMATCH'),
            ('test_commerce_nownow_order.LaneTests.test_wrong_address_refused_before_place',
             'NOWNOW_ADDRESS_BINDING_MISMATCH'),
            ('test_commerce_main_order.LaneTests.test_silent_delivery_inactive_refused_before_place',
             'MAIN_SILENT_DELIVERY_NOT_ACTIVE'),
            ('test_commerce_supermall_order.LaneTests.test_silent_delivery_inactive_refused_before_place',
             'SUPERMALL_SILENT_DELIVERY_NOT_ACTIVE'),
            ('test_commerce_nownow_order.LaneTests.test_fresh_readback_missing_quiet_note_blocks_place',
             'NOWNOW_QUIET_NOTE_MISMATCH'),
        ]
        for fixture,code in cases:
            with self.subTest(fixture=fixture):
                rows=self.replay(fixture)
                self.assertTrue(any(r['name']=='guard.refused' and r['error']['tag']==code for r in rows))

    def test_registration_records_phone_and_email_sources(self):
        from test_order_watch_notice import AddNoticeTests
        fixture=AddNoticeTests('test_slow_first_check_still_sends_and_registers')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        with tempfile.TemporaryDirectory(dir=self.base) as temp, patch.dict(os.environ,{'ROBOB_TOOL_LOG_DIR':temp}):
            for source,order in [('phone','3999004005'),('email','3999004006')]:
                code,_=fixture.add('--source',source,order=order,who='owner')
                self.assertEqual(code,0)
            rows=[json.loads(line) for p in (Path(temp)/'orders').glob('*.ndjson') for line in p.read_text().splitlines()]
            self.assertEqual([r['props']['source'] for r in rows if r['name']=='track.add'],['phone','email'])

    def test_provider_reads_success_and_failure(self):
        for success,failure,component in [
            ('test_noon_http_orders.NoonHttpTest.test_minutes_live_preparing_status_is_confirmed_tracking',
             'test_noon_http_orders.NoonHttpTest.test_inherited_expired_deadline_stops_before_session','noon'),
            ('test_careem_http_orders.CareemReadTest.test_read_contract_and_profile_precedes_tracking',
             'test_careem_http_orders.CareemReadTest.test_account_required_and_no_guest_or_ui_fallback','careem'),
            ('test_amazon_email_orders.ScanTests.test_all_accounts_first_then_only_matched_mailboxes_and_peek_cli',
             'test_amazon_email_orders.ScanTests.test_account_and_read_errors_are_explicit_without_raw_error','amazon'),
        ]:
            with self.subTest(component=component):
                good=self.replay(success);bad=self.replay(failure)
                self.assertTrue(any(r['name']=='provider.track' and r['component']==component and r.get('ok') for r in good))
                self.assertTrue(any(r['name']=='provider.track' and r['component']==component and r.get('ok') is False for r in bad))

    def test_amazon_browser_orders_success_and_failure(self):
        good=self.replay('test_amazon_dia_cli.CliTests.test_real_shape_private_envelope_yields_only_parser_output')
        bad=self.replay('test_amazon_dia_cli.CliTests.test_missing_node_fails_before_transport')
        self.assertTrue(any(r['name']=='provider.orders' and r.get('ok') for r in good))
        self.assertTrue(any(r['name']=='provider.orders' and r.get('ok') is False for r in bad))

    def test_noon_lists_and_details_cover_all_entry_points(self):
        for fixture in [
            'test_noon_http_orders.NoonHttpTest.test_orders_all_keeps_minutes_when_marketplace_fails',
            'test_noon_vertical_reads.SupermallRocketManifestTest.test_food_list_delivered_requires_agreement',
            'test_noon_vertical_reads.SupermallRocketManifestTest.test_nownow_list_unknown_on_conflict_and_duplicate_rejected',
        ]:
            with self.subTest(fixture=fixture):
                rows=self.replay(fixture)
                self.assertTrue(any(r['name']=='provider.orders' and r['component']=='noon' for r in rows))
        rows=self.replay('test_noon_order_details.DetailTests.test_minutes_does_not_guess_unit_price')
        self.assertTrue(any(r['name']=='provider.details' and r.get('ok') for r in rows))

    def test_amazon_browser_keyword_order_has_order_id(self):
        rows=self.replay('test_amazon_dia_cli.CliTests.test_track_filters_exact_id_and_missing_is_explicit')
        events=[r for r in rows if r['name']=='provider.orders']
        self.assertTrue(events)
        self.assertTrue(all('orderId' in r.get('ids',{}) for r in events))
        self.assertTrue(all('flowId' not in r.get('ids',{}) for r in events))

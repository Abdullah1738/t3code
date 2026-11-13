import datetime as dt
import contextlib
import io
import json
import importlib.machinery
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
import uuid
import os
from types import SimpleNamespace

import card_vault_fill as card
import commerce_journal as journal
import owner_go as go

HCLOUD = Path(__file__).parents[2] / 'local-helpers/bin/hcloud'
loader = importlib.machinery.SourceFileLoader('hcloud_gate', str(HCLOUD))
spec = importlib.util.spec_from_loader(loader.name, loader)
hcloud = importlib.util.module_from_spec(spec)
loader.exec_module(hcloud)


class GateTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.ledger = go.Ledger(Path(temp.name) / 'go')
        import card_status
        p = patch.dict(os.environ, {'CARD_STATUS_FILE':str(Path(temp.name) / 'cards.json')})
        p.start(); self.addCleanup(p.stop)
        card_status.record_declined('9546', reason='synthetic-test-decline', source='unit-test')
        p = patch.object(go, 'Ledger', return_value=self.ledger)
        p.start(); self.addCleanup(p.stop)
        p = patch.object(journal, 'ROOT', Path(temp.name) / 'commerce')
        p.start(); self.addCleanup(p.stop)
        self.home = Path(temp.name)
        p = patch.object(hcloud.Path, 'home', return_value=self.home)
        p.start(); self.addCleanup(p.stop)
        self.config = self.home / '.config/hcloud/cli.toml'
        self.config.parent.mkdir(parents=True)
        self.config.write_text('active_context="Default"\n[[contexts]]\nname="Default"\ntoken="synthetic-one"\n')

    def approve(self, **terms):
        self.ledger.record(**terms, quote='Yes, order that at the quoted price', source='test/message',
                           at=dt.datetime.now(go.UTC).isoformat())

    def test_card_refuses_before_keychain_or_fill_and_does_not_echo_secret(self):
        runner = Mock()
        args = dict(vendor='test', item='server', amount=100, currency='EUR', card='Marriott', field='card_cvc')
        with self.assertRaisesRegex(go.ApprovalError, 'OWNER_GO_REQUIRED'): card.fill(**args, runner=runner)
        runner.assert_not_called()
        self.approve(vendor='test', item='server', amount=100, currency='EUR')
        runner.side_effect = [subprocess.CompletedProcess([], 0, 'SECRET\n'), subprocess.CompletedProcess([], 0, 'SECRET')]
        self.assertEqual(card.fill(**args, runner=runner), {'ok':True, 'filled':'card_cvc'})
        self.assertEqual(runner.call_args_list[-1].args[0], ['ph', 'type', 'SECRET'])

    def test_dia_fill_passes_value_only_on_stdin(self):
        self.approve(vendor='test', item='server', amount=100, currency='EUR')
        runner = Mock(side_effect=[subprocess.CompletedProcess([], 0, 'SECRET\n'), subprocess.CompletedProcess([], 0)])
        card.fill(vendor='test', item='server', amount=100, currency='EUR', card='Marriott', field='card_cvc',
                  target='frame-id', selector='#cvc', runner=runner)
        call = runner.call_args_list[-1]
        self.assertNotIn('SECRET', str(call.args))
        self.assertIn('SECRET', call.kwargs['input'])

    def test_every_commerce_lane_and_financial_kind_refuses_before_consumption(self):
        for vertical in ('minutes', 'nownow', 'main', 'supermall', 'food'):
            for kind in ('place', 'payment', 'preauthorize', 'prepay'):
                with self.subTest(vertical=vertical, kind=kind):
                    flow = str(uuid.uuid4())
                    journal.open_flow(flow_id=flow, app='noon', vertical=vertical,
                                      account_hash=uuid.uuid4().hex * 2, scope_hash='b'*64)
                    args = dict(cart_hash='c'*64, review_hash='d'*64, payable_minor=200)
                    if kind == 'payment': args['payment_order_id'] = 'ORDER1'
                    if kind == 'prepay': args['payment_intent_hash'] = 'e'*64
                    with self.assertRaisesRegex(journal.JournalError, 'OWNER_GO_REQUIRED'):
                        journal.consume(flow, 'financial', kind=kind, request_hash='f'*64, **args)
                    self.assertEqual(journal.inspect(flow)['operations'], [])
                    self.assertEqual(journal.inspect(flow)['reserved_minor'], 0)

    def test_commerce_verified_actual_amount_and_basket_and_nonfinancial(self):
        flow = str(uuid.uuid4())
        journal.open_flow(flow_id=flow, app='noon', vertical='minutes', account_hash='a'*64, scope_hash='b'*64)
        self.assertTrue(journal.consume(flow, 'cart', kind='cart', request_hash='f'*64))
        journal.observe(flow, 'cart', outcome='RESPONSE_RECEIVED', evidence_hash='f'*64)
        item = go.commerce_item(journal.binding(flow))
        self.approve(vendor='noon', item=item, amount=200, currency='AED')
        args = dict(cart_hash='c'*64, review_hash='d'*64, request_hash='f'*64)
        with self.assertRaisesRegex(journal.JournalError, 'OWNER_GO_REQUIRED'):
            journal.consume(flow, 'place', kind='place', payable_minor=201, **args)
        self.assertTrue(journal.consume(flow, 'place', kind='place', payable_minor=200, **args))

    def test_hcloud_write_forms_and_missing_tool_refuse_without_execution(self):
        writes = [['server','create','--type','ccx33'], ['server','change-type','123','ccx33'],
                  ['volume','create','--size','100'], ['primary-ip','create'],
                  ['server','enable-backup','123'], ['server','create-image','123'],
                  ['load-balancer','create'], ['order','create'],
                  ['server','create','--help=false'],
                  ['--context','Default','server','create','--name','test','--type','ccx33',
                   '--image','ubuntu-24.04','--user-data','--help'],
                  ['--context=Default','server','create'], ['--context','Default','server','create']]
        for args in writes:
            with self.subTest(args=args):
                execute = Mock()
                runner = Mock(return_value=subprocess.CompletedProcess([], 4))
                self.assertEqual(hcloud.main(args, runner=runner, execute=execute), 4)
                self.assertEqual(hcloud.main(args + ['--owner-go-amount','100','--owner-go-currency','EUR',
                    '--owner-go-recurring','monthly'], runner=runner, execute=execute), 4)
                execute.assert_not_called()

    def test_hcloud_bound_arguments_and_read_paths(self):
        execute = Mock()
        runner = Mock(return_value=subprocess.CompletedProcess([], 0))
        for args in (['server','list'], ['--context','Default','server','describe','s1'],
                     ['--help'], ['help','server','create']):
            self.assertEqual(hcloud.main(args, runner=runner, execute=execute), 0)
        runner.assert_not_called()
        args = ['--context','Default','server','create','--ssh-key','123','--type','ccx33','--location','nbg1']
        self.assertEqual(hcloud.main(args + ['--owner-go-amount=100','--owner-go-currency=EUR',
                                             '--owner-go-recurring=monthly'], runner=runner, execute=execute, environment={}), 0)
        self.assertTrue(runner.call_args.args[0][5].startswith('hcloud:server:create:request:'))
        self.assertEqual(execute.call_args.args[1], [hcloud.REAL, '--debug=false', '--endpoint', hcloud.CLOUD_ENDPOINT,
            '--hetzner-endpoint', hcloud.HETZNER_ENDPOINT, *args])
        self.assertEqual(execute.call_args.args[2]['HCLOUD_TOKEN'], 'synthetic-one')

    def test_hcloud_context_credential_and_resource_identity_corpus(self):
        args = ['--context','Default','server','change-type','123','ccx33']
        item, _, _ = hcloud.bound_write(args, {})
        self.config.write_text(self.config.read_text().replace('synthetic-one','synthetic-two'))
        self.assertNotEqual(item, hcloud.bound_write(args, {})[0])
        cases = [(['server','create'], {}), (args, {'HCLOUD_TOKEN':'other'}),
                 (args, {'HCLOUD_CONTEXT':'other'}), (args, {'HCLOUD_ENDPOINT':'https://other'}),
                 (['--context','Default','server','change-type','worker','ccx33'], {}),
                 (['--context','Default','volume','attach','123','--server','worker'], {}),
                 (['--context','Default','--config','other','server','create'], {}),
                 (['--context','Default','--endpoint=https://other','server','create'], {}),
                 (['--context','Default','--hetzner-endpoint','https://other','server','create'], {}),
                 (['--context=Default','--config=other','server','create'], {}),
                 (['--context','Default','--context','other','server','create'], {}),
                 (['--context','Default','server','create','--context','other'], {}),
                 (['--context','Default','server','create','--context=other'], {})]
        for command, env in cases:
            with self.subTest(command=command, env=env), self.assertRaises(ValueError):
                hcloud.bound_write(command, env)
        for context_args in (['--context','Default'], ['--context=Default']):
            with self.subTest(context_args=context_args):
                hcloud.bound_write(context_args+['server','create','--ssh-key','123','--image','ubuntu-24.04'], {})

    def test_hcloud_unclassified_and_resource_reference_corpus(self):
        reference_flags=('--network','--firewall','--ssh-key','--primary-ipv4',
                         '--primary-ipv6','--volume','--placement-group')
        cases = [['servers','create'], ['servers','change-type','123','ccx33'],
                 ['volume','create'], ['volume','resize','123','100'],
                 ['storage-box','create','--password','SENSITIVE'], ['storage-box','change-type','123','bx21'],
                 ['server','delete','123','worker']]
        for flag in reference_flags:
            cases.extend([['server','create',flag,'worker'], ['server','create',flag+'=123,worker']])
        for words in cases:
            with self.subTest(words=words), self.assertRaises(ValueError):
                hcloud.bound_write(['--context','Default',*words], {})
        for flag in reference_flags:
            hcloud.bound_write(['--context','Default','server','create','--ssh-key','999',flag,'123,456'], {})

    def test_hcloud_pins_both_endpoints_and_never_displays_argument_values(self):
        args=['--context','Default','server','create','--ssh-key','123','--label','password=SENSITIVE']
        item, env, _=hcloud.bound_write(args,{})
        self.assertNotIn('SENSITIVE',item)
        self.assertEqual(env['HCLOUD_ENDPOINT'],'https://api.hetzner.cloud/v1')
        self.assertEqual(env['HETZNER_ENDPOINT'],'https://api.hetzner.com/v1')
        with self.assertRaises(ValueError): hcloud.bound_write(args, {'HETZNER_ENDPOINT':'https://other'})
        self.config.write_text('[preferences]\nendpoint="https://global"\nhetzner_endpoint="https://global2"\n'+
            self.config.read_text()+'\n[contexts.preferences]\nendpoint="https://other"\nhetzner_endpoint="https://other2"\n')
        _, env, _=hcloud.bound_write(args,{})
        self.assertEqual(env['HCLOUD_ENDPOINT'],hcloud.CLOUD_ENDPOINT)
        execute=Mock()
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(hcloud.main(args+['--owner-go-describe'],execute=execute,environment={}),0)
        self.assertNotIn('SENSITIVE',output.getvalue()); execute.assert_not_called()
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(hcloud.main(['--context','Default','storage-box','create','--password','SENSITIVE',
                '--owner-go-describe'],execute=execute,environment={}),4)
        self.assertNotIn('SENSITIVE',output.getvalue()); execute.assert_not_called()

    def test_nownow_custom_manifest_changes_cannot_reuse_approval(self):
        import commerce_nownow_order as nn
        base={'product_code':'P1','quantity':1,'modifiers':{},'notes':None}
        changes=[{'modifiers':{'size':'large'}}, {'modifiers':{'options':['oat','iced']}},
                 {'notes':'no sugar'}, {'notes':''}, {'notes':'no sugar\nextra ice'}]
        for count in (1,2):
            original=[base] if count==1 else [base,{**base,'product_code':'P2'}]
            def item(rows):
                normalized=nn._normalize_items(None,None,rows)
                return go.commerce_item(dict(app='noon',vertical='nownow',
                    scope_hash=nn._scope_hash('STORE',normalized,'a'*64)))
            self.approve(vendor='noon',item=item(original),amount=100,currency='AED')
            for change in changes:
                with self.subTest(count=count,change=change):
                    changed=[{**original[0],**change},*original[1:]]
                    if change.get('modifiers') or change.get('notes'):
                        with self.assertRaisesRegex(journal.JournalError,'NOWNOW_CUSTOMIZED_MANIFEST_UNSUPPORTED'):
                            item(changed)
                    else:
                        with self.assertRaises(go.ApprovalError):
                            go.require(vendor='noon',item=item(changed),amount=100,currency='AED')

    def test_hcloud_real_ledger_refusal_and_acceptance_then_credential_change(self):
        args = ['--context','Default','server','create','--ssh-key','123','--type','ccx33']
        item, _, _ = hcloud.bound_write(args, {})
        flags = ['--owner-go-amount=100','--owner-go-currency=EUR','--owner-go-recurring=monthly']
        def runner(command, **kwargs):
            with contextlib.redirect_stdout(io.StringIO()):
                code = go.main(command[1:])
            return subprocess.CompletedProcess(command, code)
        execute = Mock()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(hcloud.main(args+flags, runner=runner, execute=execute, environment={}), 4)
        execute.assert_not_called()
        self.approve(vendor='hetzner', item=item, amount=100, currency='EUR', recurring='monthly')
        self.assertEqual(hcloud.main(args+flags, runner=runner, execute=execute, environment={}), 0)
        self.config.write_text(self.config.read_text().replace('synthetic-one','synthetic-two'))
        execute.reset_mock()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(hcloud.main(args+flags, runner=runner, execute=execute, environment={}), 4)
        execute.assert_not_called()

    def test_hcloud_billable_resource_rejects_one_time_consent(self):
        args=['--context','Default','server','create','--ssh-key','123','--type','ccx33']
        item, _, cadence=hcloud.bound_write(args,{})
        self.assertEqual(cadence,'monthly')
        self.approve(vendor='hetzner',item=item,amount=100,currency='EUR')
        execute=Mock(); runner=Mock(return_value=subprocess.CompletedProcess([],0))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(hcloud.main(args+['--owner-go-amount=100','--owner-go-currency=EUR',
                '--owner-go-recurring=none'],runner=runner,execute=execute,environment={}),4)
        execute.assert_not_called(); runner.assert_not_called()

    def test_hcloud_configured_defaults_never_supply_implicit_ssh_keys(self):
        base=['--context','Default','server','create','--type','ccx33']
        for defaults in ('["named-default"]','[123,456]','[]'):
            with self.subTest(defaults=defaults):
                self.config.write_text('active_context="Default"\n[preferences]\ndefault_ssh_keys='+defaults+
                    '\n[[contexts]]\nname="Default"\ntoken="synthetic-one"\n[contexts.preferences]\ndefault_ssh_keys='+defaults+'\n')
                with self.assertRaises(ValueError): hcloud.bound_write(base,{})
                for flags in (['--ssh-key',''], ['--ssh-key='], ['--ssh-key','named-default']):
                    with self.assertRaises(ValueError): hcloud.bound_write(base+flags,{})
        args=base+['--ssh-key=123,456']
        original=hcloud.bound_write(args,{})[0]
        self.config.write_text(self.config.read_text().replace('default_ssh_keys=[]','default_ssh_keys=["other-name"]'))
        self.assertEqual(hcloud.bound_write(args,{})[0],original)
        execute=Mock(); runner=Mock(return_value=subprocess.CompletedProcess([],0))
        self.assertEqual(hcloud.main(args+['--owner-go-amount=100','--owner-go-currency=EUR',
            '--owner-go-recurring=monthly'],runner=runner,execute=execute,environment={}),0)
        self.assertIn('--ssh-key=123,456',execute.call_args.args[1])

    def test_legacy_marketplace_cannot_send_either_basket_under_shared_scope(self):
        import commerce_marketplace as legacy
        for service in ('main','supermall'):
            for offer in ('offer-1','offer-2'):
                for operation in ('place','payment_complete'):
                    with self.subTest(service=service, offer=offer, operation=operation):
                        flow = object.__new__(legacy.MarketplaceFlow)
                        flow.service=service; flow.account_hash='a'*64; flow.opened=True; flow.flow_id='test'
                        flow.owned_offers=(offer,)
                        flow.expected=SimpleNamespace(name=operation, digest='b'*64, order_id=None)
                        metadata=dict(service=service, operation=operation, request_digest='b'*64, order_id=None)
                        with patch.object(journal,'require_account_available'), patch.object(journal,'consume') as consume:
                            with self.assertRaisesRegex(journal.JournalError,'^OWNER_GO_REQUIRED$'):
                                flow._before(metadata)
                        consume.assert_not_called()

    def test_denial_survives_all_live_transport_boundaries_without_requests(self):
        from test_noon_minutes_checkout import Harness as Minutes
        from test_noon_nownow_checkout import CheckoutTests as NowNow
        from test_noon_marketplace_checkout import Harness as Marketplace
        def denied(*args):
            raise journal.JournalError('OWNER_GO_REQUIRED')
        for operation in ('place','payment_complete'):
            with self.subTest(lane='minutes', operation=operation):
                h=Minutes()
                with self.assertRaisesRegex(Exception,'^OWNER_GO_REQUIRED$'):
                    h.client._call(operation, {}, 12, denied)
                self.assertEqual(h.calls, [])
        for operation in ('place','payment_complete','payment_subscription'):
            with self.subTest(lane='nownow', operation=operation):
                h=NowNow(); client=h.client(receipt=lambda *_:True)
                payload={
                    'place': {'sessionCode':'session','total':1},
                    'payment_complete': {'clientSecret':'secret',
                        'cvvEncryption':{'encCvv':'encrypted','publicKeyName':'public'},
                        'paymentMethodCode':'cc_noonpay','idCustomerToken':'token'},
                    'payment_subscription': {'addressCode':'test-home','addressVersion':1,'paymentToken':'token'},
                }[operation]
                with self.assertRaisesRegex(Exception,'^OWNER_GO_REQUIRED$'):
                    client._call(operation, payload, 12, denied)
                self.assertEqual(h.calls, [])
        for service in ('main','supermall'):
            for operation in ('place','payment_complete'):
                with self.subTest(lane=service, operation=operation):
                    h=Marketplace(service=service)
                    args={'total':12}
                    if operation=='payment_complete':
                        h.bind(); h.calls.clear()
                        args={'order':'NTEST1','client_secret':'synthetic-secret','card_token':'token'}
                    h.client._before_send=denied
                    with self.assertRaisesRegex(Exception,'^OWNER_GO_REQUIRED$'):
                        h.client.call(operation, **args)
                    self.assertEqual(h.calls, [])
                    self.assertFalse(h.client._mutation_fenced)

    def test_cli_reports_exact_denial_code(self):
        import commerce_cli as cli
        with patch.object(cli,'card_preflight',return_value=None), \
                patch.object(cli,'order_minutes',side_effect=journal.JournalError('OWNER_GO_REQUIRED')), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(['order','minutes','--sku','TEST']),1)
        self.assertEqual(json.loads(output.getvalue())['error'],'OWNER_GO_REQUIRED')


if __name__ == '__main__': unittest.main()

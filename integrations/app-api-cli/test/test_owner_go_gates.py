import datetime as dt
import contextlib
import copy
import io
import json
import importlib.machinery
import importlib.util
from pathlib import Path
import subprocess
import shutil
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import uuid
import os
from types import SimpleNamespace

import card_vault_fill as card
import commerce_journal as journal
import owner_go as go
import toollog

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
        p = patch.dict(os.environ, {'ROBOB_TOOL_LOG_DIR': str(self.home / 'logs')})
        p.start(); self.addCleanup(p.stop)
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
        runner.side_effect = [self.completed(), self.completed(self.focus_xml()),
                              self.completed('SECRET\n'), self.completed('SECRET'), self.completed()]
        self.assertEqual(card.fill(**args, phone=True, runner=runner), {'ok':True, 'filled':'card_cvc'})
        self.assertEqual(runner.call_args_list[-2].args[0], ['ph', 'type', 'SECRET'])
        acquire, focus, _, typed, release = runner.call_args_list
        self.assertEqual(acquire.args[0][:3], ['ph', 'lease', 'acquire'])
        self.assertEqual(release.args[0][:3], ['ph', 'lease', 'release'])
        self.assertEqual(acquire.args[0][4], release.args[0][4])
        self.assertEqual(focus.kwargs['env']['PH_LEASE_OWNER'], acquire.args[0][4])
        self.assertEqual(typed.kwargs['env']['PH_LEASE_OWNER'], acquire.args[0][4])

    @staticmethod
    def completed(stdout='', code=0):
        return subprocess.CompletedProcess([], code, stdout, 'SECRET tool diagnostic')

    @staticmethod
    def focus_xml(**attrs):
        node = {'focused': 'true', 'enabled': 'true', 'class': 'android.widget.EditText', **attrs}
        return '<hierarchy><node ' + ' '.join(f'{k}="{v}"' for k, v in node.items()) + '/></hierarchy>'

    def card_args(self, **kwargs):
        return dict(vendor='test', item='server', amount=100, currency='EUR', card='Marriott', field='card_cvc', **kwargs)

    def card_cli(self, flags, runner):
        original = card.fill
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(card, 'fill', side_effect=lambda **args: original(**args, runner=runner)), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            rc = card.main(['--vendor', 'test', '--item', 'server', '--amount', '100',
                            '--currency', 'EUR', '--card', 'Marriott', '--field', 'card_cvc', *flags])
        self.assertNotIn('SECRET', output.getvalue() + errors.getvalue())
        return rc, json.loads(output.getvalue())

    def fill_rows(self):
        return [row for path in (self.home / 'logs/orders').glob('*.ndjson')
                for line in path.read_text().splitlines() if (row := json.loads(line))['name'] == 'card.fill']

    def test_card_route_matrix_refuses_before_keychain(self):
        self.approve(vendor='test', item='server', amount=100, currency='EUR')
        routes = [[], ['--cdp-target', 'frame'], ['--selector', '#cvc'],
                  ['--phone', '--cdp-target', 'frame'], ['--phone', '--selector', '#cvc'],
                  ['--phone', '--cdp-target', 'frame', '--selector', '#cvc'],
                  ['--cdp-port', '9333'], ['--phone', '--cdp-port', '9222'],
                  ['--cdp-target', '', '--selector', '#cvc'],
                  ['--cdp-target', 'frame', '--selector', '   ']]
        for flags in routes:
            with self.subTest(flags=flags):
                runner = Mock()
                self.assertEqual(self.card_cli(flags, runner),
                                 (2, {'ok': False, 'error': 'CARD_FILL_TARGET_REQUIRED'}))
                runner.assert_not_called()

    def test_card_owner_go_still_precedes_route_validation(self):
        runner = Mock()
        rc, result = self.card_cli([], runner)
        self.assertEqual((rc, result['error']), (4, 'OWNER_GO_REQUIRED'))
        runner.assert_not_called()

    def test_card_phone_requires_one_focused_editable_node(self):
        self.approve(vendor='test', item='server', amount=100, currency='EUR')
        states = ['', 'not XML SECRET', '<hierarchy/>', self.focus_xml(focused='false'),
                  self.focus_xml(enabled='false'), self.focus_xml(**{'class': 'android.widget.TextView'}),
                  '<hierarchy>' + self.focus_xml().split('<hierarchy>')[1].split('</hierarchy>')[0] * 2 + '</hierarchy>']
        for xml in states:
            with self.subTest(xml=xml):
                runner = Mock(side_effect=[self.completed(), self.completed(xml), self.completed()])
                self.assertEqual(self.card_cli(['--phone'], runner),
                                 (2, {'ok': False, 'error': 'CARD_FILL_NO_FOCUS'}))
                self.assertEqual([call.args[0][:2] for call in runner.call_args_list],
                                 [['ph', 'lease'], ['ph', 'sh'], ['ph', 'lease']])

    def test_card_phone_releases_lease_on_failure_and_never_retries_typing(self):
        self.approve(vendor='test', item='server', amount=100, currency='EUR')
        for failure_at in ('focus', 'keychain', 'type'):
            with self.subTest(failure_at=failure_at):
                results = [self.completed(), self.completed(self.focus_xml()), self.completed('SECRET'),
                           self.completed(code=4)]
                if failure_at != 'type':
                    index = {'focus': 1, 'keychain': 2}[failure_at]
                    results[index:] = [subprocess.TimeoutExpired('SECRET', 20)]
                runner = Mock(side_effect=[*results, self.completed()])
                self.assertEqual(self.card_cli(['--phone'], runner),
                                 (2, {'ok': False, 'error': 'CARD_FILL_FAILED'}))
                self.assertEqual(runner.call_args_list[-1].args[0][:3], ['ph', 'lease', 'release'])
                self.assertLessEqual(sum(c.args[0][:2] == ['ph', 'type'] for c in runner.call_args_list), 1)

    def test_card_phone_busy_refuses_before_focus_or_keychain(self):
        self.approve(vendor='test', item='server', amount=100, currency='EUR')
        runner = Mock(return_value=self.completed(code=5))
        self.assertEqual(self.card_cli(['--phone'], runner), (2, {'ok': False, 'error': 'CARD_FILL_FAILED'}))
        self.assertEqual(runner.call_count, 1)

    def test_dia_fill_passes_value_only_on_stdin(self):
        self.approve(vendor='test', item='server', amount=100, currency='EUR')
        runner = Mock(side_effect=[subprocess.CompletedProcess([], 0, 'SECRET\n'), subprocess.CompletedProcess([], 0)])
        card.fill(**self.card_args(), target='frame-id', selector='#cvc', runner=runner)
        call = runner.call_args_list[-1]
        self.assertNotIn('SECRET', str(call.args))
        self.assertIn('SECRET', call.kwargs['input'])
        self.assertEqual(json.loads(call.kwargs['input'])['port'], 9222)

    def test_cdp_port_matrix_and_stdin_only(self):
        self.approve(vendor='test', item='server', amount=100, currency='EUR')
        for port in (1, 9333, 65535):
            with self.subTest(port=port):
                runner = Mock(side_effect=[self.completed('SECRET'), self.completed()])
                self.assertEqual(self.card_cli(['--cdp-target', 'stripe-frame', '--selector', 'input[name=cvc]',
                                                '--cdp-port', str(port)], runner),
                                 (0, {'ok': True, 'filled': 'card_cvc'}))
                call = runner.call_args_list[-1]
                self.assertNotIn('SECRET', str(call.args))
                self.assertEqual(json.loads(call.kwargs['input']),
                                 dict(target='stripe-frame', selector='input[name=cvc]', port=port, value='SECRET'))
        for port in (0, 65536, -1, True, '9333', 9333.5):
            with self.subTest(port=port):
                runner = Mock()
                with self.assertRaises(ValueError):
                    card.fill(**self.card_args(), target='frame', selector='#cvc', cdp_port=port, runner=runner)
                runner.assert_not_called()
        self.assertNotIn('9222', card.CDP_FILL)
        self.assertIn('input.port', card.CDP_FILL)

    def test_card_fill_logs_one_event_per_attempt_with_no_value(self):
        self.approve(vendor='test', item='server', amount=100, currency='EUR')
        for code in (0, 2):
            runner = Mock(side_effect=[self.completed('SECRET'), self.completed('SECRET', code=code)])
            self.card_cli(['--cdp-target', 'stripe', '--selector', '#cvc', '--cdp-port', '9333'], runner)
        rows = self.fill_rows()
        self.assertEqual(len(rows), 2)
        self.assertEqual([r['ok'] for r in rows], [True, False])
        self.assertEqual(rows[1]['error']['tag'], 'CARD_FILL_FAILED')
        for row in rows:
            self.assertEqual(row['component'], 'card-vault-fill')
            self.assertEqual(row['props']['route'], 'cdp')
            self.assertEqual(row['props']['cdpPort'], 9333)
            self.assertEqual(row['props']['field'], 'card_cvc')
            self.assertEqual(row['props']['cardNickname'], 'Marriott')
            self.assertIn(row['props']['outcome'], ('success', 'failure'))
            self.assertGreaterEqual(row['durationMs'], 0)
            self.assertRegex(row['ids']['vendorId'], r'^[a-f0-9]{16}$')
            self.assertRegex(row['ids']['cardId'], r'^[a-f0-9]{16}$')
            self.assertNotIn('SECRET', json.dumps(row))
        with patch.object(toollog, '_write', side_effect=OSError('SECRET')):
            self.assertEqual(self.card_cli(['--cdp-target', 'stripe', '--selector', '#cvc'],
                                          Mock(side_effect=[self.completed('SECRET'), self.completed()])),
                             (0, {'ok': True, 'filled': 'card_cvc'}))

    def test_card_fill_refusals_log_exact_codes_and_no_raw_identity(self):
        runner = Mock()
        self.card_cli([], runner)
        self.approve(vendor='test', item='server', amount=100, currency='EUR')
        self.card_cli([], runner)
        self.card_cli(['--phone'], Mock(side_effect=[self.completed(), self.completed('<hierarchy/>'), self.completed()]))
        rows = self.fill_rows()
        self.assertEqual([r['error']['tag'] for r in rows],
                         ['OWNER_GO_REQUIRED', 'CARD_FILL_TARGET_REQUIRED', 'CARD_FILL_NO_FOCUS'])
        toollog.emit('card-vault-fill', 'card.fill', props={'cardNickname': 'SECRET', 'vendor': 'SECRET',
                    'route': 'SECRET', 'field': 'SECRET', 'cdpPort': 'SECRET'},
                    ids={'vendorId': 'SECRET', 'cardId': 'SECRET'})
        self.assertNotIn('SECRET', json.dumps(self.fill_rows()))

    def test_cdp_runtime_checks_exact_loopback_port_focus_and_nonempty_value(self):
        node = shutil.which('node')
        self.assertIsNotNone(node, 'Node is required for the CDP runtime regression')
        harness = r'''
const cfg = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
// The production script gets an independent read of the same stdin payload.
require('node:fs').readFileSync = () => JSON.stringify(cfg);
const seen = {fetch: null, socket: null, inserted: false, expressions: []};
global.fetch = async (url, options) => {
  seen.fetch = [url, options];
  return {json: async () => [{id: cfg.listedTarget ?? cfg.target, webSocketDebuggerUrl: cfg.wsUrl}]};
};
global.WebSocket = class {
  constructor(url) { seen.socket = url; this.listeners = new Set(); queueMicrotask(() => this.onopen()); }
  addEventListener(_, listener) { this.listeners.add(listener); }
  removeEventListener(_, listener) { this.listeners.delete(listener); }
  send(raw) {
    const message = JSON.parse(raw);
    let result = {};
    if (message.method === 'Runtime.evaluate') {
      seen.expressions.push(message.params.expression);
      const first = seen.expressions.length === 1;
      result = {result: {value: first ? cfg.focused : cfg.filled}};
    } else if (message.method === 'Input.insertText') {
      if (message.params.text !== cfg.value) throw Error();
      seen.inserted = true;
    }
    queueMicrotask(() => {
      for (const listener of this.listeners) listener({data: JSON.stringify({id: message.id, result})});
    });
  }
  close() {}
};
process.on('exit', () => process.stdout.write(JSON.stringify(seen)));
'''
        cases = [
            ('local ipv4', {}, 0, True),
            ('localhost', {'wsUrl': 'wss://localhost:9333/devtools/page/stripe'}, 0, True),
            ('different port', {'wsUrl': 'ws://127.0.0.1:9222/devtools/page/stripe'}, 2, False),
            ('remote', {'wsUrl': 'ws://example.com:9333/devtools/page/stripe'}, 2, False),
            ('host suffix', {'wsUrl': 'ws://localhost.example.com:9333/devtools/page/stripe'}, 2, False),
            ('credentials', {'wsUrl': 'ws://127.0.0.1:9333@example.com/devtools/page/stripe'}, 2, False),
            ('port suffix', {'wsUrl': 'ws://127.0.0.1:93330/devtools/page/stripe'}, 2, False),
            ('target mismatch', {'listedTarget': 'stripe-other'}, 2, False),
            ('no focus', {'focused': False}, 2, False),
            ('empty value', {'filled': False}, 2, True),
            ('nonboolean result', {'filled': 'SECRET'}, 2, True),
            ('port injection', {'port': '9333/SECRET'}, 2, False),
        ]
        for name, changes, code, inserted in cases:
            with self.subTest(name=name):
                payload = dict(target='stripe', selector='input[name=cvc]', value='SECRET', port=9333,
                               wsUrl='ws://127.0.0.1:9333/devtools/page/stripe', focused=True, filled=True)
                payload.update(changes)
                result = subprocess.run([node, '-e', harness + card.CDP_FILL], input=json.dumps(payload),
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, code, result.stderr)
                seen = json.loads(result.stdout)
                self.assertEqual(seen['inserted'], inserted)
                self.assertNotIn('SECRET', result.stdout + result.stderr)
                if type(payload['port']) is int:
                    self.assertEqual(seen['fetch'], ['http://127.0.0.1:9333/json/list', {'redirect': 'error'}])
                if inserted:
                    self.assertEqual(len(seen['expressions']), 2)
                    self.assertIn('e.value.length > 0', seen['expressions'][1])

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

    def test_delegated_record_passes_existing_financial_gate_and_journal_stays_at_most_once(self):
        from agent_bus_support import REQUEST, create_bus
        now = dt.datetime.now(go.UTC)
        db = self.home / 'bus.sqlite'
        create_bus(db, now)
        delegate = self.ledger.delegate(principal='moni', channel='agent-bus', quote='Yes',
            source='owner/test', at=now.isoformat(), now=now)
        flow = str(uuid.uuid4())
        journal.open_flow(flow_id=flow, app='noon', vertical='minutes',
                          account_hash='a'*64, scope_hash='b'*64)
        item = go.commerce_item(journal.binding(flow))
        with patch.dict(os.environ, {'AGENT_BUS_DB': str(db)}):
            record = self.ledger.record_delegated(principal='moni', bus_request=REQUEST,
                vendor='noon', item=item, amount=200, currency='AED', now=now)
        self.assertEqual(record['delegation'], delegate['id'])
        args = dict(cart_hash='c'*64, review_hash='d'*64, request_hash='f'*64)
        with self.assertRaisesRegex(journal.JournalError, 'OWNER_GO_REQUIRED'):
            journal.consume(flow, 'financial', kind='place', payable_minor=201, **args)
        self.assertTrue(journal.consume(flow, 'financial', kind='place', payable_minor=200, **args))
        with self.assertRaises(journal.JournalError):
            journal.consume(flow, 'financial', kind='place', payable_minor=200, **args)

    def test_food_preparation_returns_the_item_accepted_by_the_financial_gate(self):
        import commerce_cli as cli
        import commerce_food as food
        import noon_nownow_checkout as cards
        from noon_checkout import AccountHome

        rows=[{'item_code':'I1','qty':1}]
        (self.home/'commerce').mkdir(mode=0o700)
        items_file=self.home/'food-items.json'
        items_file.write_text(json.dumps(rows))
        session={'checkoutSessionCode':'SESSION1','outletCode':'OUTLET','addressCode':'ADDR',
                 'addressVersion':1,'items':food.manifest(rows),'orderTotal':10,
                 'orderPaymentAmount':10,'orderWalletAmount':0,
                 'deliveryPreferenceInfo':[{'code':k,'value':False} for k in food.QUIET]}
        operations=[]
        def request(operation, headers, body):
            operations.append(operation)
            if operation=='create':return {'checkoutSessionCode':'SESSION1'}
            if operation=='details':return copy.deepcopy(session)
            if operation=='set-delivery-preference':
                session['deliveryPreferenceInfo']=[{'code':k,'value':v} for k,v in body['deliveryPreference'].items()]
            elif operation=='add-notes':session['driverNotes']=body['driverNotes']
            elif operation=='set-payment-method':
                session.update(creditCardMask=body['creditCardMask'],paymentMethodCode=body['paymentMethod'],
                               prepaidPaymentMethodCode=body['prepaidPaymentMethod'])
            else:self.fail('unexpected Food request: '+operation)
            return {}

        menu=({'status':'open','serviceable':True,'menu_code':'MENU1','menu_version':1,'name':'Store'},
              [{'id':'I1','name':'Item','available':True,'max_quantity':3,'choice_groups':[]}])
        home=AccountHome('main','a'*64,'b'*64,time.time())
        with patch.object(food,'ROOT',self.home/'commerce/food'), \
                patch.object(food.order_card,'LAST4','2342'), patch.object(cli,'PAUSE_FILE',self.home/'paused'), \
                patch.object(food.vertical,'_headers',return_value={'x-addresscode':'ADDR','x-addresskey':'ADDR-1'}), \
                patch.object(food.core,'request',return_value={}), patch.object(food,'project_home',return_value=home), \
                patch.object(food.native,'food_menu_raw',return_value=menu), \
                patch.object(food.vertical,'food_orders',return_value={'orders':[]}), \
                patch.object(cards,'native_request',return_value={'data':[{
                    'ccMasked':'****2342','id':161,'isDeleted':False}]}), \
                patch.object(food,'request',side_effect=request):
            args=['order','food','--outlet-code','OUTLET','--items-file',str(items_file),'--prepare-only']
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(cli.main(args),0,output.getvalue())
            prepared=json.loads(output.getvalue().splitlines()[-1])
            flow=prepared['flow_id']
            item=prepared['owner_go_item']
            amount=prepared['review']['payable_minor']
            self.assertFalse(prepared['financial_send'])
            self.assertFalse(any(o['kind'] in ('place','payment') for o in journal.inspect(flow)['operations']))
            sends=list(operations)
            items_file.write_text(json.dumps({'items':rows}))
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(cli.main(args+['--resume-flow',flow]),0,output.getvalue())
            resumed=json.loads(output.getvalue().splitlines()[-1])
            self.assertEqual(resumed['owner_go_item'],item)
            self.assertEqual([op for op in operations[len(sends):] if op!='details'],[])

            financial=dict(request_hash='c'*64,cart_hash='d'*64,review_hash='e'*64,payable_minor=amount)
            with self.assertRaisesRegex(journal.JournalError,'^OWNER_GO_REQUIRED$'):
                journal.consume(flow,'place',kind='place',**financial)
            self.approve(vendor='noon',item=item,amount=amount,currency=prepared['review']['currency'])
            self.assertTrue(journal.consume(flow,'place',kind='place',**financial))
            self.assertEqual(journal.inspect(flow)['reserved_minor'],amount)

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

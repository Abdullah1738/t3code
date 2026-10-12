import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MAX_BYTES, SafeError, safeCode, decodeTool, selectTab, projectResponse, runRead,
  bridgeEnvironment } from '../amazon_dia_transport.mjs';

const url = 'https://www.amazon.ae/gp/your-account/order-history';
const tool = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const tab = (id = 'tab-1', targetId = 'target-1') => ({ id, url, loading: false,
  targetMatches: [{ targetId, browserContextId: 'context-1', url, title: 'private-title' }] });
const inventory = () => ({ profiles: [{ profile: 'Personal', mappingStatus: 'mapped',
  browserContextId: 'context-1', tabs: [tab()] }] });
const response = () => ({ profileName: 'Personal', diaTabId: 'tab-1', target: {
  id: 'target-1', targetId: 'target-1', type: 'page', browserContextId: 'context-1', url,
  title: 'private-title', webSocketDebuggerUrl: 'private-websocket' },
  result: { result: { type: 'object', value: { schema: 'amazon.ae.orders.dom.v1', orders: [] } } } });

test('unique existing Personal orders tab and exact context/URL', () => {
  assert.deepEqual(selectTab(inventory()), { tab_id: 'tab-1', target_id: 'target-1', context: 'context-1', url });
});
test('ambiguous tabs fail; explicit tab selects without creating one', () => {
  const i = inventory(); i.profiles[0].tabs.push(tab('tab-2', 'target-2'));
  assert.throws(() => selectTab(i), /AMAZON_ORDERS_TAB_AMBIGUOUS/);
  assert.equal(selectTab(i, 'tab-2').target_id, 'target-2');
  assert.throws(() => selectTab(i, 'missing'), /TAB_NOT_FOUND/);
});
test('unmapped or duplicated Personal profile fail', () => {
  const i = inventory(); i.profiles[0].mappingStatus = 'unresolved';
  assert.throws(() => selectTab(i), /DIA_PROFILE_UNMAPPED/);
  i.profiles.push(i.profiles[0]);
  assert.throws(() => selectTab(i), /PERSONAL_PROFILE_REQUIRED/);
});
test('never reads another profile or unrelated page', () => {
  const i = inventory(); i.profiles[0].profile = 'Equicom';
  assert.throws(() => selectTab(i), /PERSONAL_PROFILE_REQUIRED/);
  for (const bad of ['https://www.amazon.com/gp/your-account/order-history', 'https://www.amazon.ae/gp/cart/view.html',
    'https://www.amazon.ae.evil.invalid/gp/your-account/order-history',
    'https://u:p@www.amazon.ae/gp/your-account/order-history', 'http://www.amazon.ae/gp/your-account/order-history']) {
    const j = inventory(); j.profiles[0].tabs[0].url = bad;
    assert.throws(() => selectTab(j), /AMAZON_ORDERS_TAB_REQUIRED/);
    assert.throws(() => selectTab(j, 'tab-1'), /UNSUPPORTED_PAGE/);
  }
});
test('loading, same-title target, foreign context and duplicate targets fail', () => {
  const i = inventory(); i.profiles[0].tabs[0].loading = true;
  assert.throws(() => selectTab(i), /PAGE_NOT_READY/);
  for (const change of [t => { t.url += '?different=1'; }, t => { t.browserContextId = 'foreign'; }]) {
    const j = inventory(); change(j.profiles[0].tabs[0].targetMatches[0]);
    assert.throws(() => selectTab(j), /DIA_TARGET_AMBIGUOUS/);
  }
  const j = inventory(); j.profiles[0].tabs[0].targetMatches.push(j.profiles[0].tabs[0].targetMatches[0]);
  assert.throws(() => selectTab(j), /DIA_TARGET_AMBIGUOUS/);
});
test('MCP errors and malformed/oversize values never echo', () => {
  for (const value of [{ isError: true, content: [{ type: 'text', text: 'private error' }] }, tool([]),
    { content: [{ type: 'text', text: '{secret' }] }, { content: [] }]) {
    assert.throws(() => decodeTool(value), e => e instanceof SafeError && !e.message.includes('private'));
  }
  assert.throws(() => decodeTool({ content: [{ type: 'text', text: 'x'.repeat(MAX_BYTES + 1) }] }), /DIA_RESPONSE_TOO_LARGE/);
});
test('actual merged target id/targetId and targetId-only shape; private metadata stripped', () => {
  const r = response(), b = selectTab(inventory());
  r.target.url += '?private=secret#private'; b.url = r.target.url;
  const value = projectResponse(r, b), serialized = JSON.stringify(value);
  for (const privateText of ['private', 'secret', 'webSocketDebuggerUrl', 'title', 'browserContextId'])
    assert.ok(!serialized.includes(privateText));
  assert.equal(value.response.target.targetId, 'target-1');
  delete r.target.id;
  assert.equal(projectResponse(r, b).binding.target_id, 'target-1');
  r.target.id = 'different';
  assert.throws(() => projectResponse(r, b), /DIA_BINDING_MISMATCH/);
});
test('evaluate navigation races, profile/tab/target/context changes reject', () => {
  const changes = [r => { r.profileName = 'Equicom'; }, r => { r.diaTabId = null; },
    r => { r.target.targetId = 'wrong'; }, r => { r.target.browserContextId = 'foreign'; }];
  for (const change of changes) {
    const r = response(); change(r);
    assert.throws(() => projectResponse(r, selectTab(inventory())), /DIA_BINDING_MISMATCH/);
  }
  const r = response(); r.target.url += '?orderId=different';
  assert.throws(() => projectResponse(r, selectTab(inventory())), /DIA_LOCATION_MISMATCH/);
});
test('evaluate exceptions do not cross output boundary', () => {
  const r = response(); r.result.exceptionDetails = { text: 'private exception' };
  assert.throws(() => projectResponse(r, selectTab(inventory())), /DIA_INVALID_RESPONSE/);
});
test('exactly profiles then evaluate; tabId only and fixed expression', async () => {
  const calls = [];
  const client = { callTool: async (...args) => { calls.push(args); return tool(calls.length === 1 ? inventory() : response()); } };
  await runRead(client, { expression: 'fixed-fixture', deadline: Date.now() + 1000 });
  assert.deepEqual(calls.map(x => x[0].name), ['dia_profiles', 'dia_evaluate']);
  assert.deepEqual(calls[1][0].arguments, { profileName: 'Personal', tabId: 'tab-1', expression: 'fixed-fixture',
    awaitPromise: true, returnByValue: true });
  assert.ok(calls.every(x => x[2].timeout > 0 && !x[2].resetTimeoutOnProgress));
});
test('bad inventory never evaluates and expired deadline never calls MCP', async () => {
  let count = 0;
  const client = { callTool: async () => { count++; return tool({ profiles: [] }); } };
  await assert.rejects(runRead(client, { expression: 'fixed', deadline: Date.now() + 1000 }), /PERSONAL_PROFILE_REQUIRED/);
  assert.equal(count, 1);
  await assert.rejects(runRead(client, { expression: 'fixed', deadline: 0 }), /DIA_TIMEOUT/);
  assert.equal(count, 1);
});
test('bridge env forcibly disables auto-heal, pins local endpoint and strips secrets/debug', () => {
  const before = { ...process.env };
  try {
    process.env.DIA_AUTO_HEAL = '1'; process.env.DIA_CDP_ENDPOINT = 'https://bad.invalid';
    process.env.NODE_OPTIONS = '--inspect'; process.env.PRIVATE_SECRET = 'private';
    const env = bridgeEnvironment(2000);
    assert.equal(env.DIA_AUTO_HEAL, '0');
    assert.equal(env.DIA_CDP_ENDPOINT, 'http://127.0.0.1:9222');
    assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.PRIVATE_SECRET, undefined);
  } finally { process.env = before; }
});
test('unknown errors collapse to static code', () => {
  assert.equal(safeCode(new Error('private SDK failure')), 'DIA_TRANSPORT_FAILED');
  assert.equal(safeCode(new SafeError('private failure')), 'DIA_TRANSPORT_FAILED');
  assert.equal(safeCode(new SafeError('DIA_TIMEOUT')), 'DIA_TIMEOUT');
});
test('helper loads official SDK only and no arbitrary expression/bridge CLI option', async () => {
  const source = await readFile(new URL('../amazon_dia_transport.mjs', import.meta.url), 'utf8');
  for (const s of ['new WebSocket(', 'fetch(', 'playwright', 'dia_navigate', 'dia_tab_create', 'document.cookie'])
    assert.ok(!source.includes(s));
  assert.ok(source.includes('new StdioClientTransport('));
  assert.ok(source.includes('maxBufferSize: MAX_BYTES'));
  const python = await readFile(new URL('../amazon_browser_orders.py', import.meta.url), 'utf8');
  assert.ok(python.match(/^DIA_EXTRACTOR = r"""([\s\S]*?)"""$/m)?.[1].startsWith('(async () =>'));
});

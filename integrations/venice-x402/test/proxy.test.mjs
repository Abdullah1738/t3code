import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recoverMessageAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CapError, Ledger, actualCost, estimateAndClamp } from '../lib/caps.mjs';
import { FALLBACK_MODELS, loadConfig } from '../lib/config.mjs';
import { createProxy } from '../lib/server.mjs';
import { siwxHeader } from '../lib/siwx.mjs';
import { Venice } from '../lib/venice.mjs';

const MODEL = 'abliteration-abliterated-model-large-v2';
const price = FALLBACK_MODELS[MODEL];
const account = privateKeyToAccount(generatePrivateKey()); // throwaway test key
const PAYTO = '0x2670B922ef37C7Df47158725C0CC407b5382293F';

function cfgFor(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vx402-'));
  return { ...loadConfig({ HOME: dir, VENICE_X402_DATA_DIR: dir, VENICE_X402_API_BASE: 'https://api.venice.ai/api/v1' }), ...extra };
}

test('siwx header is a signed EIP-4361 message Venice can rebuild', async () => {
  const url = 'https://api.venice.ai/api/v1/chat/completions';
  const { header, message } = await siwxHeader(account, url, { nonce: 'abcdef1234567890' });
  const p = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  assert.equal(p.domain, 'api.venice.ai');
  assert.equal(p.chainId, 'eip155:8453');
  assert.equal(p.type, 'eip191');
  assert.equal(p.uri, url);
  assert.match(message, /^api\.venice\.ai wants you to sign in with your Ethereum account:\n0x[0-9a-fA-F]{40}\n\nSign in to Venice AI\n\nURI: https:\/\/api\.venice\.ai\/api\/v1\/chat\/completions\nVersion: 1\nChain ID: 8453\nNonce: abcdef1234567890\nIssued At: /);
  assert.ok(message.includes(`Issued At: ${p.issuedAt}`) && message.includes(`Expiration Time: ${p.expirationTime}`));
  assert.equal(await recoverMessageAddress({ message, signature: p.signature }), account.address);
});

test('estimate clamps output to the per-request cap and rejects huge inputs', () => {
  const body = { model: MODEL, messages: [{ role: 'user', content: 'hi' }] };
  const e = estimateAndClamp(body, price, 0.5);
  assert.equal(body.max_completion_tokens, price.maxOutput); // 32768 * $5/M = $0.16 fits
  assert.ok(e.estUsd <= 0.5);
  const big = { model: MODEL, messages: [{ role: 'user', content: 'x'.repeat(420_000) }], max_tokens: 32768 };
  const e2 = estimateAndClamp(big, price, 0.5);
  assert.ok(e2.clamped && big.max_tokens < 32768 && e2.estUsd <= 0.5 + 1e-9);
  assert.throws(() => estimateAndClamp({ messages: [{ content: 'x'.repeat(600_000) }] }, price, 0.5), CapError);
  // small explicit max_tokens is honoured, not rejected (parent's 429 repro)
  const small = { model: MODEL, max_tokens: 20, messages: [{ role: 'user', content: 'Say hi in five words or less.' }] };
  const e3 = estimateAndClamp(small, price, 0.5);
  assert.equal(small.max_tokens, 20);
  assert.equal(e3.clamped, false);
  assert.ok(e3.estUsd > 0.006 && e3.estUsd < 0.007); // includes Venice's hidden prompt overhead
  // cap squeezes output under the floor -> rejected with a clear message
  assert.throws(() => estimateAndClamp({ messages: [{ content: 'x'.repeat(493_000) }], max_tokens: 4096 }, price, 0.5), /of 4096 requested/);
});

test('actual cost uses cached rate for cached prompt tokens', () => {
  const c = actualCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 500_000 } }, price);
  assert.equal(c.costUsd, 1.5 + 0.15 + 5);
});

test('ledger enforces daily spend and top-up caps and survives restart', () => {
  const cfg = cfgFor({ maxDailyUsd: 1, maxTopUpDailyUsd: 10, maxTopUpPerPaymentUsd: 5 });
  const l = new Ledger(cfg);
  const id = l.reserve(0.4);
  assert.throws(() => l.reserve(0.7), /daily cap/);
  l.release(id);
  l.record({ kind: 'charge', costUsd: 0.9 });
  assert.throws(() => l.reserve(0.2), /daily cap/);
  l.record({ kind: 'topup_signed', amountUsd: 5 });
  l.record({ kind: 'topup_signed', amountUsd: 5 });
  assert.throws(() => l.checkTopUp(5), /daily top-up cap/);
  l.record({ kind: 'topup_released', amountUsd: 5 });
  l.checkTopUp(5);
  assert.throws(() => l.checkTopUp(6), /per-payment cap/);
  const again = new Ledger(cfg);
  assert.equal(again.snapshot().spent, 0.9);
  assert.equal(again.snapshot().toppedUp, 5);
});

function mockVenice({ payTo = PAYTO, credit = 0 } = {}) {
  const calls = [];
  const state = { credit };
  const required = {
    x402Version: 2,
    resource: { url: 'https://api.venice.ai/api/v1/x402/top-up', description: 'Venice', mimeType: 'application/json' },
    accepts: [
      { scheme: 'exact', network: 'eip155:8453', amount: '5000000', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', payTo, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } },
    ],
  };
  const fetchImpl = async (url, init = {}) => {
    const h = init.headers || {};
    const u = new URL(url);
    calls.push({ path: u.pathname, siwx: !!h['SIGN-IN-WITH-X'], payment: !!(h['PAYMENT-SIGNATURE'] || h['payment-signature']), body: init.body });
    if (u.pathname.endsWith('/x402/top-up')) {
      const sig = h['PAYMENT-SIGNATURE'] || h['payment-signature'];
      if (!sig) {
        return new Response(JSON.stringify(required), { status: 402, headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64') } });
      }
      const p = JSON.parse(Buffer.from(sig, 'base64').toString('utf8'));
      assert.equal(p.payload.authorization.to.toLowerCase(), payTo.toLowerCase());
      assert.equal(p.payload.authorization.value, '5000000');
      assert.equal(p.payload.authorization.from, account.address);
      state.credit += 5;
      return new Response(JSON.stringify({ success: true, data: { amountCredited: 5, newBalance: state.credit, paymentId: 'x402-test' } }), { status: 200 });
    }
    if (u.pathname.includes('/x402/balance/')) {
      return new Response(JSON.stringify({ success: true, data: { balanceUsd: state.credit, canConsume: state.credit >= 0.1 } }), { status: 200 });
    }
    if (u.pathname.endsWith('/chat/completions')) {
      assert.ok(h['SIGN-IN-WITH-X']);
      if (state.credit < 0.1) return new Response(JSON.stringify({ code: 'PAYMENT_REQUIRED', reason: 'insufficient_balance' }), { status: 402 });
      const body = JSON.parse(init.body);
      if (body.stream) {
        const sse = `data: {"id":"c1","choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"id":"c1","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":100}}\n\ndata: [DONE]\n\n`;
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ id: 'c1', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }), { status: 200 });
    }
    if (u.pathname.endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return new Response('nope', { status: 404 });
  };
  return { fetchImpl, calls, state };
}

async function startProxy(cfg, mock, opts = {}) {
  const ledger = new Ledger(cfg);
  const venice = new Venice({ cfg, account, ledger, fetchImpl: mock.fetchImpl });
  const token = 't'.repeat(40);
  const { server } = createProxy({ cfg, venice, ledger, clientToken: token, egressCheck: opts.egressCheck });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const call = (path, body, auth = token) =>
    fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { server, ledger, call };
}

test('proxy tops up once on 402, retries, and books the cost', async () => {
  const mock = mockVenice();
  const p = await startProxy(cfgFor(), mock);
  try {
    assert.equal((await p.call('/models', null, 'wrong')).status, 401);
    const models = await (await p.call('/models')).json();
    assert.deepEqual(models.data.map((m) => m.id), [MODEL]);
    const r = await p.call('/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).choices[0].message.content, 'hi');
    assert.equal(mock.calls.filter((c) => c.path.endsWith('/x402/top-up') && c.payment).length, 1);
    const snap = p.ledger.snapshot();
    assert.equal(snap.toppedUp, 5);
    assert.equal(snap.spent, 1000 * price.input + 100 * price.output);
    // stream: usage parsed from the final chunk, include_usage forced on
    const s = await p.call('/chat/completions', { model: MODEL, stream: true, reasoning_effort: 'high', messages: [{ role: 'user', content: 'hi' }] });
    assert.match(await s.text(), /\[DONE\]/);
    assert.equal(JSON.parse(mock.calls.at(-1).body).stream_options.include_usage, true);
    assert.equal(JSON.parse(mock.calls.at(-1).body).reasoning_effort, undefined);
    assert.equal(p.ledger.snapshot().requests, 2);
    assert.equal((await p.call('/chat/completions', { model: 'other', messages: [] })).status, 400);
  } finally {
    p.server.close();
  }
});

test('top-up refuses an unexpected payTo and egress failure blocks sending', async () => {
  const mock = mockVenice({ payTo: '0x000000000000000000000000000000000000dEaD' });
  const p = await startProxy(cfgFor(), mock);
  try {
    const r = await p.call('/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 402);
    assert.match((await r.json()).error.message, /refusing to pay/);
    assert.equal(mock.calls.filter((c) => c.payment).length, 0);
  } finally {
    p.server.close();
  }
  const mock2 = mockVenice({ credit: 5 });
  const p2 = await startProxy(cfgFor(), mock2, { egressCheck: async () => false });
  try {
    const r = await p2.call('/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 503);
    assert.equal(mock2.calls.length, 0);
  } finally {
    p2.server.close();
  }
});

test('egress check runs the command async and caches only success', async () => {
  const { defaultEgressCheck } = await import('../lib/server.mjs');
  assert.equal(await defaultEgressCheck({ egressCheck: 'exit 1', egressCheckTtlMs: 60_000 })(), false);
  const ok = defaultEgressCheck({ egressCheck: 'exit 0', egressCheckTtlMs: 60_000 });
  assert.equal(await ok(), true);
  assert.equal(await ok(), true);
  assert.equal(await defaultEgressCheck({ egressCheck: '', egressCheckTtlMs: 1 })(), true);
});

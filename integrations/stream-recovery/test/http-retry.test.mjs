import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ctl, activeSessions, ocInterrupt, PATHS, fetchIdempotent } from '../lib/io.mjs';
import { timedScan } from '../lib/logging.mjs';
import { fixture } from '../../router-logging/test/support.mjs';

const privateText = 'https://user:password@example.invalid/private?token=sk-private';
const socketError = code => new TypeError('fetch failed', {
  cause:Object.assign(new Error(privateText), {code}),
});
const clients = {
  control: { get:() => ctl('GET', '/private'), post:() => ctl('POST', '/private', {text:privateText}), timeout:15_000 },
  opencode: { get:activeSessions, post:() => ocInterrupt('ses_fixture'), timeout:20_000 },
};

function setup(t) {
  const log = fixture(t);
  const before = { ...PATHS };
  PATHS.ocPassword = join(log.root, 'password');
  PATHS.dataDir = log.root;
  writeFileSync(PATHS.ocPassword, 'fixture');
  const env = { T3_CONTROL_URL:process.env.T3_CONTROL_URL, T3_CONTROL_TOKEN:process.env.T3_CONTROL_TOKEN,
    T3_CONTROL_TOKEN_FILE:process.env.T3_CONTROL_TOKEN_FILE };
  process.env.T3_CONTROL_URL = 'http://fixture.invalid';
  process.env.T3_CONTROL_TOKEN = 'fixture';
  process.env.T3_CONTROL_TOKEN_FILE = join(log.root, 'absent');
  t.after(() => {
    Object.assign(PATHS, before);
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return log;
}

for (const [target, client] of Object.entries(clients)) {
  for (const tag of ['EPIPE', 'ECONNRESET', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']) {
    test(`${target} GET retries ${tag} once with a fresh timeout and a private log`, async t => {
      const { rows } = setup(t);
      const calls = [], timeouts = [];
      t.mock.method(AbortSignal, 'timeout', ms => {
        timeouts.push(ms);
        return new AbortController().signal;
      });
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        calls.push(init);
        if (calls.length === 1) throw socketError(tag);
        return Response.json({ok:true, data:{ses_fixture:{}}});
      });
      const result = await client.get();
      if (target === 'control') assert.equal(result.ok, true);
      else assert.deepEqual([...result], ['ses_fixture']);
      assert.equal(calls.length, 2);
      assert.notEqual(calls[0].signal, calls[1].signal);
      assert.deepEqual(timeouts, [client.timeout, client.timeout]);
      const retries = rows().filter(row => row.name === 'http.retry');
      assert.equal(retries.length, 1);
      assert.deepEqual(retries[0].props, {target, tag, ok:true});
      const errors = rows().filter(row => row.kind === 'error');
      assert.equal(errors.length, ['EPIPE','ECONNRESET'].includes(tag) ? 1 : 0);
      if (errors.length) {
        assert.equal(errors[0].props.errno, tag);
        assert.equal(errors[0].props.attemptNo, 1);
        assert.equal(errors[0].props.target, target === 'control' ? 'http://fixture.invalid:80' : 'http://127.0.0.1:49374');
      }
      for (const text of ['example.invalid', 'password', 'sk-private', '/private', 'url']) {
        assert.ok(!JSON.stringify(rows()).includes(text));
      }
    });
  }

  const noRetry = [
    ['refused', () => socketError('ECONNREFUSED')],
    ['connect timeout', () => socketError('UND_ERR_CONNECT_TIMEOUT')],
    ['AbortError', () => new DOMException('The operation was aborted', 'AbortError')],
    ['TimeoutError', () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
    ['abort with socket cause', () => Object.assign(new Error('fetch failed', {cause:{code:'EPIPE'}}), {name:'AbortError'})],
    ['timeout with socket cause', () => Object.assign(new Error('fetch failed', {cause:{code:'ECONNRESET'}}), {name:'TimeoutError'})],
    ['wrong error type', () => new Error('fetch failed', {cause:{code:'EPIPE'}})],
    ['wrong message', () => new TypeError(privateText, {cause:{code:'EPIPE'}})],
    ['missing cause', () => new TypeError('fetch failed')],
    ['cause name without code', () => new TypeError('fetch failed', {cause:{name:'EPIPE'}})],
  ];
  for (const [label, makeError] of noRetry) test(`${target} GET does not retry ${label}`, async t => {
    const { rows } = setup(t);
    const error = makeError();
    const stub = t.mock.method(globalThis, 'fetch', async () => {throw error;});
    await assert.rejects(client.get(), e => e === error);
    assert.equal(stub.mock.callCount(), 1);
    assert.deepEqual(rows(), []);
  });

  test(`${target} HTTP errors and POST socket errors are never retried`, async t => {
    const { rows } = setup(t);
    const stub = t.mock.method(globalThis, 'fetch', async () => Response.json({ok:false}, {status:500}));
    await assert.rejects(client.get(), /500/);
    assert.equal(stub.mock.callCount(), 1);
    const error = socketError('EPIPE');
    stub.mock.mockImplementation(async () => {throw error;});
    await assert.rejects(client.post(), e => e === error);
    assert.equal(stub.mock.callCount(), 2);
    assert.deepEqual(rows(), []);
  });

  test(`${target} throws the second socket error and logs exactly one failed retry`, async t => {
    const { rows } = setup(t);
    const first = socketError('EPIPE'), second = socketError('ECONNRESET');
    let calls = 0;
    const stub = t.mock.method(globalThis, 'fetch', async () => {
      throw ++calls === 1 ? first : second;
    });
    await assert.rejects(timedScan('stall', {[target === 'control' ? 'harnessCutoverStatus' : 'activeSessions']:client.get},
      io => io[target === 'control' ? 'harnessCutoverStatus' : 'activeSessions']()), e => e === second);
    assert.equal(stub.mock.callCount(), 2);
    const retries = rows().filter(row => row.name === 'http.retry');
    assert.equal(retries.length, 1);
    assert.deepEqual(retries[0].props, {target, tag:'EPIPE', ok:false});
    const errors = rows().filter(row => row.kind === 'error');
    assert.deepEqual(errors.map(row => row.error.tag), ['EPIPE','ECONNRESET']);
    assert.deepEqual(errors.map(row => row.props.attemptNo), [1,2]);
  });

  test(`${target} does not retry a retry's HTTP 500`, async t => {
    const { rows } = setup(t);
    let calls = 0;
    const stub = t.mock.method(globalThis, 'fetch', async () => {
      if (++calls === 1) throw socketError('EPIPE');
      return Response.json({ok:false}, {status:500});
    });
    await assert.rejects(client.get(), /500/);
    assert.equal(stub.mock.callCount(), 2);
    assert.deepEqual(rows().find(row => row.name === 'http.retry').props, {target, tag:'EPIPE', ok:false});
  });
}

for (const init of [{method:'POST'}, {method:'PUT'}, {method:'DELETE'}, {method:'PATCH'}, {method:'HEAD'},
  {method:'GET',body:''}, {body:'private'}]) {
  test(`shared helper does not retry ${JSON.stringify(init)}`, async t => {
    const { rows } = setup(t);
    const error = socketError('EPIPE');
    const stub = t.mock.method(globalThis, 'fetch', async () => {throw error;});
    await assert.rejects(fetchIdempotent('control', privateText, init, 15_000), e => e === error);
    assert.equal(stub.mock.callCount(), 1);
    assert.deepEqual(rows(), []);
  });
}

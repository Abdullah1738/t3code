import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {fixture} from './support.mjs';
import {clean, safeTarget, tagConnectionFailure, observed, errorScan, connectionErrnos, connectionWebSocket, emit, reportVolume} from '../toollog.mjs';
import {timedScan} from '../../stream-recovery/lib/logging.mjs';
import {fetchIdempotent, robobHealthy} from '../../stream-recovery/lib/io.mjs';
import {check} from '../../catalog-guard/cli.mjs';
import {harnessCutoverStatus, refreshProviders} from '../../catalog-guard/lib/io.mjs';

function controlEnv(t, url) {
  for (const [key,value] of Object.entries({T3_CONTROL_URL:url,T3_CONTROL_TOKEN:'private'})) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {if (previous === undefined) delete process.env[key]; else process.env[key] = previous;});
  }
}

const now = '2026-11-18T06:00:00.000Z';
test('endpoint forms strip credentials, paths, queries and fragments in the writer', () => {
  const cases = [
    ['http://user:private@127.0.0.1:20128/path?token=private#private', 'http://127.0.0.1:20128'],
    ['https://user:private@EXAMPLE.com:443/?key=private', 'https://example.com:443'],
    ['wss://user:private@[::1]:3773/ws?token=private', 'wss://[::1]:3773'],
    ['ws://localhost/ws', 'ws://localhost:80'],
    ['http://localhost:0/', 'http://localhost:0'],
    ...['file:///private', 'http:private', '//host:80', 'http://bad:99999', 'https://good\\@private', 'https://good/\nprivate', 'not a URL'].map(v => [v, undefined]),
  ];
  for (const [input, expected] of cases) {
    assert.equal(safeTarget(input), expected, input);
    assert.equal(clean({component:'test',name:'connection',kind:'error',props:{target:input}}).props?.target, expected);
  }
  const row = clean({component:'test',name:'connection',kind:'error',props:{
    target:'http://user:private@127.0.0.1:80/path?secret=private', step:'activeSessions', errno:'ECONNREFUSED',
    syscall:'connect', attemptNo:2, count:3, firstTs:now, lastTs:now,
  }});
  assert.deepEqual(row.props, {target:'http://127.0.0.1:80',step:'activeSessions',errno:'ECONNREFUSED',syscall:'connect',attemptNo:2,count:3,firstTs:now,lastTs:now});
});

test('real loopback refusal retains endpoint, errno, syscall and step', async t => {
  const {rows} = fixture(t);
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const url = `http://127.0.0.1:${port}/private?token=private`;
  await assert.rejects(timedScan('stall', {activeSessions:() => fetchIdempotent('opencode', url, {}, 2000)}, io => io.activeSessions()));
  const errors = rows().filter(row => row.error?.tag === 'ECONNREFUSED');
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0].props, {target:`http://127.0.0.1:${port}`,errno:'ECONNREFUSED',syscall:'connect',attemptNo:1,phase:'activeSessions',step:'activeSessions',count:1,firstTs:errors[0].props.firstTs,lastTs:errors[0].props.lastTs});
  assert.ok(!JSON.stringify(rows()).includes('private'));
});

test('scan collapses independent failures, records swallowed reads, and separates scans and targets', async t => {
  const {rows} = fixture(t);
  const fail = (url, errno = 'ECONNREFUSED') => {
    throw tagConnectionFailure(Object.freeze(new TypeError('fetch failed', {cause:{code:errno,syscall:'connect'}})), url);
  };
  const io = {activeSessions:() => fail('http://user:private@127.0.0.1:3773/path?token=private'),
    getThread:() => fail('http://127.0.0.1:3773/another'),
    ocSession:() => fail('http://127.0.0.1:49374'),
    ocForms:() => fail('http://127.0.0.1:3773', 'ECONNRESET')};
  await timedScan('stall', io, async timed => {
    for (const operation of ['activeSessions','activeSessions','getThread','ocSession','ocForms']) {
      try { await timed[operation](); } catch {}
    }
  });
  const errors = rows().filter(row => row.kind === 'error');
  assert.equal(errors.length, 3);
  assert.equal(errors[0].props.count, 3);
  assert.ok(errors[0].props.lastTs >= errors[0].props.firstTs);
  assert.ok(rows().some(row => row.name === 'stall.scan' && row.ok));
  await assert.rejects(timedScan('stall', io, timed => timed.activeSessions()));
  assert.equal(rows().filter(row => row.kind === 'error').at(-1).props.count, 1);
  assert.ok(!JSON.stringify(rows()).includes('private'));
});

test('all requested errnos survive nested causes and failed retry carries attempt two', async t => {
  const {rows} = fixture(t);
  for (const code of connectionErrnos) {
    const error = new TypeError('fetch failed', {cause:new AggregateError([{code,syscall:'getaddrinfo'}])});
    await assert.rejects(errorScan(() => observed('test','fixture.connection', () => {
      throw tagConnectionFailure(error, 'https://user:private@example.com/path?token=private', 2);
    }, {props:{step:'resolve'}})));
    assert.equal(rows().at(-1).props.errno, code);
    assert.equal(rows().at(-1).props.attemptNo, 2);
  }
  const original = globalThis.fetch;
  t.after(() => {globalThis.fetch = original;});
  let attempts = 0;
  globalThis.fetch = async () => {attempts++;throw new TypeError('fetch failed', {cause:{code:'ECONNRESET',syscall:'read'}});};
  await assert.rejects(timedScan('stall', {activeSessions:() => fetchIdempotent('control','http://127.0.0.1:3773',{},2000)}, io => io.activeSessions()));
  assert.equal(attempts, 2);
  assert.equal(rows().findLast(row => row.error?.tag === 'ECONNRESET').props.attemptNo, 2);
  assert.equal(rows().findLast(row => row.error?.tag === 'ECONNRESET').props.count, 2);
});

test('health probe logs swallowed connection failures and preserves false result', async t => {
  const {rows} = fixture(t);
  controlEnv(t, 'http://127.0.0.1:3773');
  t.mock.method(globalThis, 'fetch', async () => {throw new TypeError('fetch failed',{cause:{code:'ECONNREFUSED',syscall:'connect'}});});
  assert.equal(await timedScan('restart', {robobHealthy}, io => io.robobHealthy()), false);
  const errors = rows().filter(row => row.error?.tag === 'ECONNREFUSED');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].props.target, 'http://127.0.0.1:3773');
  assert.equal(errors[0].props.step, 'robobHealthy');
});

test('work outliving the scan flush writes its late connection failure directly', async t => {
  const {rows} = fixture(t);
  const pending = Promise.withResolvers();
  let late;
  await errorScan(async () => {
    late = observed('stream-recovery','stall.scan',() => pending.promise,{props:{step:'ocSession'}}).catch(() => {});
  });
  const error = tagConnectionFailure(new TypeError('fetch failed',{cause:{code:'ECONNRESET',syscall:'read'}}),'http://127.0.0.1:49374');
  pending.reject(error);
  await late;
  const errors = rows().filter(row => row.error?.tag === 'ECONNRESET');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].props.target, 'http://127.0.0.1:49374');
  assert.equal(errors[0].props.count, 1);
});

test('real native WebSocket refusals retain transport errno for both helpers', async t => {
  const {rows, root} = fixture(t);
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  controlEnv(t, `http://127.0.0.1:${port}`);
  await assert.rejects(errorScan(() => observed('catalog-guard','catalog.refresh',() => refreshProviders({timeoutMs:2000}),{props:{step:'refreshProviders'}})));
  // The stream helper deliberately caches its control URL for the process.
  const script = `import {dispatchCommand} from ${JSON.stringify(new URL('../../stream-recovery/lib/io.mjs',import.meta.url).href)};
    import {timedScan} from ${JSON.stringify(new URL('../../stream-recovery/lib/logging.mjs',import.meta.url).href)};
    import assert from 'node:assert/strict';
    await assert.rejects(timedScan('restart', {dispatchCommand}, io => io.dispatchCommand({type:'queue.resume'}, {timeoutMs:2000})));`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {env:{...process.env,STREAM_RECOVERY_DATA:root},timeout:5000});
  const errors = rows().filter(row => row.error?.tag === 'ECONNREFUSED');
  assert.equal(errors.length, 2);
  for (const row of errors) {
    assert.equal(row.props.target, `ws://127.0.0.1:${port}`);
    assert.equal(row.props.syscall, 'connect');
    assert.equal(row.props.attemptNo, 1);
    assert.ok(['refreshProviders','dispatchCommand'].includes(row.props.step));
  }
});

test('upgraded native WebSockets retain real socket resets on concurrent connections', {timeout:5000}, async t => {
  const {rows} = fixture(t);
  const server = createHttpServer();
  const sockets = new Set();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.once('data', () => socket.resetAndDestroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const target = `ws://127.0.0.1:${server.address().port}`;
  const run = component => errorScan(() => observed(component, 'fixture.socket', () => new Promise((resolve, reject) => {
    const url = `${target}/${component}?token=private`;
    const socket = connectionWebSocket(url);
    socket.addEventListener('open', () => socket.send('x'.repeat(1024 * 1024)));
    socket.addEventListener('error', event => reject(tagConnectionFailure(new Error('socket error', {cause:event.error ?? event}), url)));
    socket.addEventListener('close', () => reject(new Error('closed before reply')));
  }), {props:{step:'reply'}}));
  await Promise.all(['catalog-guard','stream-recovery'].map(component => assert.rejects(run(component))));
  const errors = rows().filter(row => ['EPIPE','ECONNRESET'].includes(row.error?.tag));
  assert.equal(errors.length, 2);
  for (const row of errors) {
    assert.equal(row.props.target, target);
    assert.ok(['read','write'].includes(row.props.syscall));
    assert.equal(row.props.step, 'reply');
  }
  assert.ok(!JSON.stringify(rows()).includes('private'));
});

for (const late of [false,true]) test(`final line bound includes timestamps on ${late ? 'late' : 'collapsed'} errors`, async t => {
  const {rows} = fixture(t);
  const keys = ['model','size','status','enabled','locked','limited','reloginNeeded','state','action','tag','dryRun','complete','cost','hour',
    'exitCode','attempt','source','failed','total','fourxx','fivexx','phase','durationMaxMs','omitted','firstAttemptMs','retryAttemptMs',
    'outcome','consecutive','sinceMs','longestSyncOp','step'];
  const props = Object.fromEntries(keys.map(key => [key,'x'.repeat(100)]));
  Object.assign(props, {target:`http://${'h'.repeat(110)}.invalid:20128`,errno:'ECONNREFUSED',syscall:'connect',attemptNo:1,count:1});
  const event = {component:'x'.repeat(100),name:'x'.repeat(100),kind:'error',props,error:{tag:'ECONNREFUSED'}};
  const initial = Buffer.byteLength(JSON.stringify(clean(event))+'\n');
  assert.ok(initial > 4025 && initial <= 4096, initial);
  const pending = Promise.withResolvers();
  let write;
  await errorScan(async () => {
    if (late) write = pending.promise.then(() => emit(event.component, event.name, event));
    else emit(event.component, event.name, event);
  });
  if (late) {pending.resolve();await write;}
  assert.equal(rows().length, 0);
  reportVolume();
  const report = rows().find(row => row.name === 'log.volume');
  assert.equal(report.props.droppedByReason.line_size, 1);
  assert.ok(rows().every(row => Buffer.byteLength(JSON.stringify(row)+'\n') <= 4096));
});

test('catalog transport failure names the control endpoint and phase without duplicate parent errors', async t => {
  const {rows} = fixture(t);
  const original = globalThis.fetch;
  const previous = {url:process.env.T3_CONTROL_URL,token:process.env.T3_CONTROL_TOKEN};
  t.after(() => {
    globalThis.fetch = original;
    for (const [key,value] of [['T3_CONTROL_URL',previous.url],['T3_CONTROL_TOKEN',previous.token]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.T3_CONTROL_URL = 'http://127.0.0.1:3773';
  process.env.T3_CONTROL_TOKEN = 'private';
  globalThis.fetch = async () => {throw new TypeError('fetch failed',{cause:{code:'ECONNREFUSED',syscall:'connect'}});};
  await assert.rejects(check({dryRun:true,cache:'fixture'}, {INSTANCE_ID:'opencode',readJson:()=>null,harnessCutoverStatus}));
  const errors = rows().filter(row => row.error?.tag === 'ECONNREFUSED');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].props.target, 'http://127.0.0.1:3773');
  assert.equal(errors[0].props.step, 'harnessCutoverStatus');
  assert.ok(rows().every(row => Buffer.byteLength(JSON.stringify(row)+'\n') <= 4096));
});

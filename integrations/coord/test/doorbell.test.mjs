import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../lib/coord.mjs';
import { deliver } from '../lib/pump.mjs';
import { fresh, advance, stubControl, resetHooks } from './helpers.mjs';

let stub;
beforeEach(async () => {
  fresh();
  resetHooks();
  stub = await stubControl({ states: { 'T-master': 'idle', 'T-cell': 'idle' } });
  C.actorSet('master', { thread: 'T-master' });
  C.actorSet('release', { thread: 'T-master' });
  C.actorSet('cell', { thread: 'T-cell' });
  C.actorSet('crw', { kind: 'process' });
  C.channelCreate('ops', { owner: 'master' });
  for (const a of ['master', 'release', 'cell']) C.memberAdd('ops', a, { wake: true });
});
afterEach(async () => { await stub.close(); C.close(); });

const post = (key, o = {}) => C.post('ops', { as: 'crw', kind: 'status', key, summary: key, to: ['master'], ...o }).seq;
const status = (seq, as = 'master') => C.inbox({ as }).events.find(e => e.seq === seq).delivery;

test('deliveries for one thread coalesce into one wake that points at the inbox', async () => {
  const s = [post('a'), post('b'), post('c')];
  const d = await deliver({ cfg: stub.cfg });
  assert.equal(stub.sends.length, 1);
  assert.equal(stub.sends[0].mode, 'queue');
  assert.equal(stub.sends[0].text.split('\n')[0],
    `[coord] 3 unacked deliveries for master (seqs ${s[0]}-${s[2]}, newest: #${s[2]} status from crw: c). Read \`coord inbox --as master --unacked\`, handle, ack.`);
  assert.deepEqual(d.sent.map(x => x.seq), s);
  assert.equal(new Set(C.inbox({ as: 'master' }).events.map(e => e.delivery)).size, 1);
  assert.deepEqual(d.wakes, [{ thread: 'T-master', kind: 'wake', deliveries: 3, delivery: 'started' }]);
  assert.equal((await deliver({ cfg: stub.cfg })).sent.length, 0, 'nothing new, no ring');
  assert.equal(stub.sends.length, 1);
});

test('actors sharing a thread get one wake with a line each; other threads get their own', async () => {
  post('m');
  post('r', { to: ['release'] });
  post('x', { to: ['cell'] });
  await deliver({ cfg: stub.cfg });
  assert.deepEqual(stub.sends.map(x => x.thread).sort(), ['T-cell', 'T-master']);
  const m = stub.sends.find(x => x.thread === 'T-master').text;
  assert.match(m, /^\[coord\] 1 unacked delivery for master /);
  assert.match(m, /\n\[coord\] 1 unacked delivery for release /);
});

test('no ring while the thread is running; one wake for everything once it is idle', async () => {
  stub.states['T-master'] = 'running';
  const a = post('a');
  assert.equal((await deliver({ cfg: stub.cfg })).sent.length, 0);
  const b = post('b');
  stub.states['T-master'] = 'needs-input';
  await deliver({ cfg: stub.cfg });
  assert.equal(stub.sends.length, 0);
  assert.equal(status(a), 'pending');
  stub.states['T-master'] = 'idle';
  const d = await deliver({ cfg: stub.cfg });
  assert.deepEqual(d.sent.map(x => x.seq), [a, b]);
  assert.equal(stub.sends.length, 1);
});

test('while the last wake is still queued unread, new deliveries ride on it; ring again once it was read', async () => {
  const a = post('a');
  await deliver({ cfg: stub.cfg });
  const run = Object.keys(stub.runs)[0];
  stub.runs[run] = 'queued';
  stub.states['T-master'] = 'queued';
  const b = post('b');
  const d = await deliver({ cfg: stub.cfg });
  assert.deepEqual(d.sent.map(x => [x.seq, x.delivery]), [[b, 'coalesced']]);
  assert.equal(stub.sends.length, 1, 'no second queued turn');
  const rows = C.inbox({ as: 'master' }).events;
  assert.equal(rows.find(e => e.seq === b).delivery, 'sent');
  stub.runs[run] = 'completed';
  stub.states['T-master'] = 'idle';
  C.ack('master', [a, b]);
  const c = post('c');
  assert.deepEqual((await deliver({ cfg: stub.cfg })).sent.map(x => x.seq), [c]);
  assert.equal(stub.sends.length, 2);
  assert.match(stub.sends[1].text, new RegExp(`^\\[coord\\] 1 unacked delivery for master \\(seq ${c},`));
});

test('reminders: one per thread per window after its last ring, only while idle, each delivery reminded once', async () => {
  const a = post('a');
  await deliver({ cfg: stub.cfg });
  advance(600);
  const b = post('b');
  await deliver({ cfg: stub.cfg });
  assert.equal(stub.sends.length, 2);
  advance(C.DEFAULTS.unackedAfter - 599);
  assert.equal((await deliver({ cfg: stub.cfg })).reminded.length, 0, 'a is stale, but the wake for b listed it 20 min ago');
  advance(600);
  stub.states['T-master'] = 'running';
  assert.equal((await deliver({ cfg: stub.cfg })).reminded.length, 0, 'not while busy');
  stub.states['T-master'] = 'idle';
  const r1 = await deliver({ cfg: stub.cfg });
  assert.deepEqual(r1.reminded.map(x => x.seq), [a, b], 'one reminder covers both');
  assert.equal(stub.sends.length, 3);
  assert.match(stub.sends.at(-1).text, new RegExp(`^\\[coord reminder\\] 2 unacked deliveries for master \\(seqs ${a}-${b},`));
  advance(C.DEFAULTS.unackedAfter + 1);
  assert.equal((await deliver({ cfg: stub.cfg })).reminded.length, 0, 'each delivery is reminded once, then attention');
  assert.equal(stub.sends.length, 3);
  assert.equal(C.attention().unacked.filter(u => u.recipient === 'master').length, 2);
});

test('a new delivery rings before a reminder, and the reminder waits its window', async () => {
  post('a');
  await deliver({ cfg: stub.cfg });
  advance(C.DEFAULTS.unackedAfter + 1);
  const b = post('b');
  const d = await deliver({ cfg: stub.cfg });
  assert.deepEqual([d.sent.map(x => x.seq), d.reminded.length], [[b], 0]);
  assert.equal((await deliver({ cfg: stub.cfg })).reminded.length, 0);
  advance(C.DEFAULTS.unackedAfter + 1);
  assert.equal((await deliver({ cfg: stub.cfg })).reminded.length, 2);
  assert.equal(stub.sends.length, 3);
});

test('single-recipient control and blocker summaries go inline; broadcasts do not', async () => {
  const c = post('stop now', { kind: 'control' });
  const k = post('blocked on x', { kind: 'blocker' });
  post('fyi', { kind: 'request' });
  C.post('ops', { as: 'crw', kind: 'control', key: 'all', summary: 'everyone pause' });
  await deliver({ cfg: stub.cfg });
  const m = stub.sends.find(x => x.thread === 'T-master').text;
  assert.match(m, new RegExp(`\\n  control #${c} from crw: stop now\\n  blocker #${k} from crw: blocked on x\\n`));
  assert.doesNotMatch(m, /fyi\n|everyone pause\n/);
  assert.match(m, /newest: #\d+ control from crw: everyone pause\)/);
});

test('a crash after Robob accepted the wake replays it under the same clientRequestId', async () => {
  post('a');
  post('b');
  let crash = true;
  const { sendToThread } = await import('../lib/pump.mjs');
  const send = async (...x) => { const r = await sendToThread(...x); if (crash) { crash = false; throw new Error('died'); } return r; };
  assert.equal((await deliver({ cfg: stub.cfg, send })).retry.length, 2);
  advance(200);
  const d = await deliver({ cfg: stub.cfg, send });
  assert.equal(d.sent.length, 2);
  assert.equal(stub.sends[1].clientRequestId, stub.sends[0].clientRequestId);
  assert.equal(stub.messages['T-master'].length, 1);
});

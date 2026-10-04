import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../lib/coord.mjs';
import { deliver, pump, HEAL } from '../lib/pump.mjs';
import { fresh, advance, stubControl, resetHooks } from './helpers.mjs';

let stub;
beforeEach(async () => {
  fresh();
  resetHooks();
  stub = await stubControl({ states: { 'T-master': 'idle' } });
  C.actorSet('master', { thread: 'T-master' });
  C.actorSet('crw', { kind: 'process' });
  C.channelCreate('ops', { owner: 'master' });
  C.memberAdd('ops', 'master', { wake: true });
});
afterEach(async () => { await stub.close(); C.close(); });

const post = key => C.post('ops', { as: 'crw', kind: 'status', key, summary: key, to: ['master'] }).seq;
const iso = () => new Date(C.clock.now() * 1000).toISOString();
const status = seq => C.inbox({ as: 'master' }).events.find(e => e.seq === seq).delivery;

test('a held queue (state queued, nothing moving) is rung instead of skipped forever', async () => {
  // A run Robob held after a restart: queued, never started.
  stub.runs['held-1'] = 'queued';
  stub.runThread['held-1'] = 'T-master';
  stub.runTimes['held-1'] = { requestedAt: iso(), startedAt: null, completedAt: null };
  stub.states['T-master'] = 'queued';
  const a = post('a');
  let d = await deliver({ cfg: stub.cfg });
  assert.equal(d.sent.length, 0, 'not yet: a queue may still be draining');
  assert.equal(status(a), 'pending');
  advance(HEAL.heldQueueAfter);
  const b = post('b');
  d = await deliver({ cfg: stub.cfg });
  assert.deepEqual(d.sent.map(x => x.seq), [a, b]);
  assert.equal(d.healed, 1);
  assert.deepEqual(d.heals, [{ thread: 'T-master', reason: 'held_queue' }]);
  assert.equal(stub.sends.length, 1);
});

test('new deliveries do not coalesce onto a wake that sits behind a held queue', async () => {
  const a = post('a');
  stub.states['T-master'] = 'running';
  await deliver({ cfg: stub.cfg });
  stub.states['T-master'] = 'idle';
  await deliver({ cfg: stub.cfg });
  const run = Object.keys(stub.runs)[0];
  // The wake got queued, then the server restarted and held the queue.
  stub.runs[run] = 'queued';
  stub.states['T-master'] = 'queued';
  advance(HEAL.relostAfter);
  const b = post('b');
  const d = await deliver({ cfg: stub.cfg });
  assert.ok(!d.sent.some(x => x.delivery === 'coalesced'));
  assert.deepEqual(d.sent.map(x => x.seq).sort(), [a, b]);
  assert.equal(d.heals[0].reason, 'lost_wake+held_queue');
  assert.equal(stub.sends.length, 2);
  assert.notEqual(stub.sends[1].clientRequestId, stub.sends[0].clientRequestId);
});

test('a wake whose turn failed is re-rung with a fresh clientRequestId', async () => {
  const a = post('a');
  await deliver({ cfg: stub.cfg });
  const run = Object.keys(stub.runs)[0];
  stub.runs[run] = 'failed';
  assert.equal((await deliver({ cfg: stub.cfg })).sent.length, 0, 'rate-limited right after the ring');
  advance(HEAL.relostAfter);
  const d = await deliver({ cfg: stub.cfg });
  assert.deepEqual(d.sent.map(x => x.seq), [a]);
  assert.deepEqual(d.heals, [{ thread: 'T-master', reason: 'lost_wake' }]);
  assert.equal(stub.sends.length, 2);
  assert.notEqual(stub.sends[1].clientRequestId, stub.sends[0].clientRequestId);
  assert.equal(stub.messages['T-master'].length, 2);
  // Acked rows are never re-rung.
  C.ack('master', [a]);
  stub.runs[Object.keys(stub.runs)[1]] = 'failed';
  advance(HEAL.relostAfter);
  assert.equal((await deliver({ cfg: stub.cfg })).sent.length, 0);
});

test('an interrupted or never-started cancelled wake is not re-rung', async () => {
  post('a');
  await deliver({ cfg: stub.cfg });
  const run = Object.keys(stub.runs)[0];
  stub.runs[run] = 'interrupted';
  advance(HEAL.relostAfter);
  assert.equal((await deliver({ cfg: stub.cfg })).sent.length, 0);
  stub.runs[run] = 'cancelled';
  stub.runTimes[run].startedAt = null;
  assert.equal((await deliver({ cfg: stub.cfg })).sent.length, 0);
  assert.equal(stub.sends.length, 1);
});

test('a long turn gets a queued wake once deliveries are overdue; a short one does not', async () => {
  stub.states['T-master'] = 'running';
  stub.active['T-master'] = { startedAt: iso() };
  const a = post('a');
  let d = await deliver({ cfg: stub.cfg });
  assert.equal(d.sent.length, 0);
  assert.deepEqual(d.stuck, []);
  advance(C.DEFAULTS.unackedAfter);
  d = await deliver({ cfg: stub.cfg });
  assert.deepEqual(d.sent.map(x => [x.seq, x.delivery]), [[a, 'queued']]);
  assert.deepEqual(d.heals, [{ thread: 'T-master', reason: 'long_run' }]);
  assert.equal(stub.sends[0].mode, 'queue');
  // The queued wake now absorbs later deliveries.
  const b = post('b');
  d = await deliver({ cfg: stub.cfg });
  assert.deepEqual(d.sent.map(x => [x.seq, x.delivery]), [[b, 'coalesced']]);
  assert.equal(stub.sends.length, 1);
});

test('a short busy turn with overdue deliveries is reported as stuck, not rung', async () => {
  const a = post('a');
  advance(C.DEFAULTS.unackedAfter);
  stub.states['T-master'] = 'running';
  stub.active['T-master'] = { startedAt: iso() };
  const d = await deliver({ cfg: stub.cfg });
  assert.equal(d.sent.length, 0);
  assert.deepEqual(d.stuck, [{ thread: 'T-master', state: 'running', oldest_min: 30 }]);
  assert.equal(status(a), 'pending');
  assert.deepEqual(C.attention().pending_overdue.map(x => [x.recipient, x.n]), [['master', 1]]);
});

test('every pump tick writes a heartbeat that attention reads', async () => {
  assert.equal(C.attention().pump.stale, true);
  const out = await pump({ cfg: stub.cfg });
  assert.equal(out.heartbeat.gap_s, null);
  assert.equal(C.attention().pump.stale, false);
  advance(60);
  assert.equal((await pump({ cfg: stub.cfg })).heartbeat.gap_s, 60);
  advance(301);
  assert.equal(C.attention().pump.stale, true);
});

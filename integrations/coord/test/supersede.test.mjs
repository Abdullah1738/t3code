import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../lib/coord.mjs';
import { deliver, pump, HEAL } from '../lib/pump.mjs';
import { fresh, advance, stubControl, resetHooks } from './helpers.mjs';

let stub;
beforeEach(async () => {
  fresh();
  resetHooks();
  stub = await stubControl({ states: { 'T-master': 'idle', 'T-cell': 'idle' } });
  C.actorSet('master', { thread: 'T-master' });
  C.actorSet('cell', { thread: 'T-cell' });
  C.actorSet('crw', { kind: 'process' });
  C.channelCreate('ops', { owner: 'master' });
  for (const a of ['master', 'cell']) C.memberAdd('ops', a, { wake: true });
});
afterEach(async () => { await stub.close(); C.close(); });

const post = (key, to = 'master') => C.post('ops', { as: 'crw', kind: 'status', key, summary: key, to: [to] }).seq;
const run = (o = {}) => deliver({ cfg: stub.cfg, queue: stub.queue, ...o });
const status = (seq, as = 'master') => C.inbox({ as }).events.find(e => e.seq === seq).delivery;

// Rings `key` for master while the thread is running, so the wake stays queued; then a restart holds it.
async function heldWake(key) {
  const seq = post(key);
  stub.states['T-master'] = 'running';
  stub.active['T-master'] = { startedAt: new Date(C.clock.now() * 1000).toISOString() };
  advance(C.DEFAULTS.unackedAfter);
  advance(HEAL.longRunAfter);
  await run();
  const runId = Object.keys(stub.runs).at(-1);
  assert.equal(stub.runs[runId], 'queued');
  delete stub.active['T-master'];
  stub.states['T-master'] = 'queued';
  return { seq, runId };
}

test('ringing a held thread cancels the pump\'s earlier queued wake and nothing else', async () => {
  const { seq: a, runId: oldWake } = await heldWake('a');
  stub.enqueue('T-master', 'owner-1', 'please also check the logs');
  stub.enqueue('T-master', 'notice-1', 'Background task completed.');
  // Same text shape, but not sent by the pump: never touched.
  stub.enqueue('T-master', 'pasted-1', '[coord] 1 unacked delivery for master (pasted by an agent)');
  advance(HEAL.heldQueueAfter);
  const b = post('b');
  const d = await run();
  assert.deepEqual(stub.cancels, [oldWake]);
  assert.equal(stub.runs['owner-1'], 'queued');
  assert.equal(stub.runs['notice-1'], 'queued');
  assert.equal(stub.runs['pasted-1'], 'queued');
  assert.equal(d.superseded, 1);
  assert.equal(d.supersedes[0].thread, 'T-master');
  // The new wake covers the cancelled wake's deliveries too.
  assert.deepEqual(d.sent.map(x => x.seq).sort(), [a, b]);
  assert.equal(stub.sends.length, 2);
  assert.match(stub.sends[1].text, /2 unacked deliveries for master/);
  assert.equal(stub.runs[Object.keys(stub.runs).at(-1)], 'completed');
});

test('a ring on an idle thread does not list its queue', async () => {
  let listed = 0;
  const queue = { ...stub.queue, list: async (...a) => { listed++; return stub.queue.list(...a); } };
  post('a');
  await deliver({ cfg: stub.cfg, queue });
  assert.equal(listed, 0);
  assert.equal(stub.sends.length, 1);
});

test('a thread held 10+ min with only coord wakes queued gets them replaced by one fresh wake', async () => {
  const { seq: a, runId: w1 } = await heldWake('a');
  // A second stale wake, e.g. from before a restart, the pump no longer tracks.
  stub.enqueue('T-master', 'old-wake', '[coord reminder] 1 unacked delivery for master', 'ardud-control:send:T-master:coord%3Aremind%3Aabc');
  advance(HEAL.staleHeldAfter);
  const d = await run();
  assert.deepEqual(stub.cancels.sort(), [w1, 'old-wake'].sort());
  assert.equal(d.superseded, 2);
  assert.ok(d.supersedes.some(s => s.reason === 'stale_held' && s.runs === 2 && s.requeued === 1));
  assert.deepEqual(d.sent.map(x => x.seq), [a]);
  assert.equal(stub.sends.length, 2);
  assert.equal(status(a), 'sent');
  assert.deepEqual(C.attention().held_queues, []);
});

test('a stale held queue with other items is not swept, only listed in attention', async () => {
  await heldWake('a');
  stub.enqueue('T-master', 'owner-1', 'owner message from before the restart');
  stub.runTimes['owner-1'].requestedAt = new Date((C.clock.now() - 60) * 1000).toISOString();
  advance(HEAL.staleHeldAfter);
  // Nothing new is due and the wake is rate-limited, so only the sweep looks at the thread.
  C.ack('master', C.inbox({ as: 'master', unacked: true }).events.map(e => e.seq));
  const d = await run();
  assert.deepEqual(stub.cancels, []);
  assert.equal(d.superseded, 0);
  const h = C.attention().held_queues;
  assert.equal(h.length, 1);
  assert.equal(h[0].thread, 'T-master');
  assert.deepEqual(h[0].actors, ['master']);
  assert.equal(h[0].coord, 1);
  assert.deepEqual(h[0].other.map(x => x.runId), ['owner-1']);
  assert.ok(h[0].held_min >= 10);
});

test('the sweep runs at most once per sweepEvery and a cleared queue drops out of attention', async () => {
  await heldWake('a');
  stub.enqueue('T-master', 'owner-1', 'owner message');
  advance(HEAL.staleHeldAfter);
  C.ack('master', C.inbox({ as: 'master', unacked: true }).events.map(e => e.seq));
  await run();
  assert.equal(C.attention().held_queues.length, 1);
  stub.runs['owner-1'] = 'cancelled';
  stub.states['T-master'] = 'idle';
  await run();
  assert.equal(C.attention().held_queues.length, 1, 'not re-swept yet');
  advance(HEAL.sweepEvery);
  await run();
  assert.deepEqual(C.attention().held_queues, []);
});

test('a failing cancel is reported and does not block the ring', async () => {
  const { seq: a } = await heldWake('a');
  advance(HEAL.relostAfter);
  const queue = { ...stub.queue, cancel: async () => { throw new Error('dispatch refused'); } };
  const d = await deliver({ cfg: stub.cfg, queue });
  assert.equal(d.superseded, 0);
  assert.ok(d.queueErrors.some(e => e.error === 'dispatch refused'));
  assert.ok(d.sent.some(x => x.seq === a));
});

test('the heartbeat counts superseded runs', async () => {
  await heldWake('a');
  advance(HEAL.staleHeldAfter);
  const out = await pump({ cfg: stub.cfg, queue: stub.queue });
  assert.equal(out.heartbeat.superseded, 1);
  const v = JSON.parse(C.status().control.find(c => c.k === 'pump:heartbeat').v);
  assert.equal(v.superseded, 1);
});

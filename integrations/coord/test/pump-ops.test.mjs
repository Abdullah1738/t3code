import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { rotateLog } from '../lib/pump.mjs';
import { heartbeatCheck } from '../scripts/pump-heartbeat.mjs';
import { tmp } from './helpers.mjs';

test('the pump log moves to .1 once it is over the limit, replacing the older .1', () => {
  const log = join(tmp(), 'coord-pump.log');
  assert.equal(rotateLog(log, 10), null);
  writeFileSync(log, '0123456789');
  assert.equal(rotateLog(log, 10), null);
  writeFileSync(`${log}.1`, 'older');
  writeFileSync(log, '0123456789a');
  assert.deepEqual(rotateLog(log, 10), { rotated: `${log}.1` });
  assert.equal(existsSync(log), false);
  assert.equal(readFileSync(`${log}.1`, 'utf8'), '0123456789a');
  assert.equal(rotateLog(undefined, 10), null);
});

function harness(t0 = 1_800_000_000) {
  const h = { now: t0, pump: { last_tick: t0 - 400, stale: true }, state: {}, sent: [], failSend: false, loseAck: false, bridge: new Map() };
  h.run = () => heartbeatCheck({
    now: h.now,
    attention: () => ({ ok: true, pump: h.pump }),
    // Like the Telegram bridge: a reused key must carry the same text.
    notify: a => {
      if (h.failSend) throw new Error('bridge down');
      if (h.bridge.has(a.key) && h.bridge.get(a.key) !== a.text) throw new Error('key reused with different text');
      if (!h.bridge.has(a.key)) h.sent.push(a);
      h.bridge.set(a.key, a.text);
      if (h.loseAck) throw new Error('ack lost');
    },
    load: () => structuredClone(h.state),
    save: v => { h.state = v; },
  });
  return h;
}

test('a stale pump alerts after a second sighting, repeats every 6 h and notes the recovery once', () => {
  const h = harness();
  const since = h.now;
  assert.equal(h.run(), null);
  h.now += 300;
  const first = h.run();
  assert.equal(first.severity, 'attention');
  assert.equal(first.key, `coord-pump-heartbeat:${since}:1`);
  assert.match(first.text, /has not ticked since/);
  h.now += 300;
  assert.equal(h.run(), null);
  h.now += 6 * 3600;
  assert.equal(h.run().key, `coord-pump-heartbeat:${since}:2`);
  h.pump = { last_tick: h.now, stale: false };
  assert.deepEqual(h.run(), { severity: 'info', key: `coord-pump-heartbeat:${since}:ok`, text: h.sent.at(-1).text });
  assert.equal(h.run(), null);
  assert.equal(h.sent.length, 3);
  assert.deepEqual(h.state, {});
});

test('a single stale sighting that clears sends nothing', () => {
  const h = harness();
  h.run();
  h.now += 60;
  h.pump = { last_tick: h.now, stale: false };
  assert.equal(h.run(), null);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.state, {});
});

test('a failed alert is retried with the same key on the next run', () => {
  const h = harness();
  h.pump = { last_tick: null, stale: true };
  h.run();
  h.now += 300;
  h.failSend = true;
  assert.throws(() => h.run(), /bridge down/);
  h.failSend = false;
  h.now += 300;
  const a = h.run();
  assert.equal(a.key, `coord-pump-heartbeat:${h.now - 600}:1`);
  assert.match(a.text, /has never written a heartbeat/);
});

test('attention without a pump field is an error, not a healthy pump', () => {
  const h = harness();
  assert.throws(() => heartbeatCheck({ now: h.now, attention: () => ({ ok: true }), notify() {}, load: () => ({}), save() {} }),
    /no pump field/);
});

test('an alert whose acknowledgement was lost is replayed unchanged while the last tick moves', () => {
  const h = harness();
  const since = h.now;
  h.run();
  h.now += 300;
  h.loseAck = true;
  assert.throws(() => h.run(), /ack lost/);
  h.loseAck = false;
  h.pump = { last_tick: h.now - 100, stale: true };
  h.now += 300;
  assert.equal(h.run().key, `coord-pump-heartbeat:${since}:1`);
  h.pump = { last_tick: h.now, stale: false };
  h.loseAck = true;
  assert.throws(() => h.run(), /ack lost/);
  h.loseAck = false;
  h.now += 300;
  h.pump = { last_tick: h.now, stale: false };
  assert.equal(h.run().key, `coord-pump-heartbeat:${since}:ok`);
  assert.equal(h.run(), null);
  assert.deepEqual(h.sent.map(a => a.key), [`coord-pump-heartbeat:${since}:1`, `coord-pump-heartbeat:${since}:ok`]);
  assert.deepEqual(h.state, {});
});

test('an alert retried after a long bridge outage waits another 6 h before repeating', () => {
  const h = harness();
  const since = h.now;
  h.run();
  h.now += 300;
  h.failSend = true;
  assert.throws(() => h.run(), /bridge down/);
  h.now += 7 * 3600;
  assert.throws(() => h.run(), /bridge down/);
  h.failSend = false;
  h.now += 300;
  assert.equal(h.run().key, `coord-pump-heartbeat:${since}:1`);
  assert.equal(h.sent.length, 1);
  h.now += 5 * 3600;
  assert.equal(h.run(), null);
  h.now += 3600;
  assert.equal(h.run().key, `coord-pump-heartbeat:${since}:2`);
});

test('a recovery seen while Telegram is down still ends that outage, so the next one starts fresh', () => {
  const h = harness();
  const first = h.now;
  h.run();
  h.now += 300;
  h.failSend = true;
  assert.throws(() => h.run(), /bridge down/);
  h.now += 300;
  h.pump = { last_tick: h.now, stale: false };
  assert.throws(() => h.run(), /bridge down/);
  h.now += 600;
  const second = h.now;
  h.pump = { last_tick: h.now - 400, stale: true };
  assert.equal(h.run(), null); // unconfirmed: the queue waits
  h.failSend = false;
  h.now += 300;
  assert.equal(h.run().key, `coord-pump-heartbeat:${second}:1`);
  // The first outage's recovery note was overtaken by the second outage, which gets its own alerts.
  assert.deepEqual(h.sent.map(a => a.key), [`coord-pump-heartbeat:${first}:1`, `coord-pump-heartbeat:${second}:1`]);
  h.now += 5 * 3600;
  assert.equal(h.run(), null);
  h.pump = { last_tick: h.now, stale: false };
  assert.equal(h.run().key, `coord-pump-heartbeat:${second}:ok`);
  assert.deepEqual(h.state, {});
});

test('a held recovery note waits while a new outage is still unconfirmed', () => {
  const h = harness();
  const first = h.now;
  h.run();
  h.now += 300;
  h.run();
  // The recovery note was tried and failed, so it heads the queue.
  h.now += 300;
  h.pump = { last_tick: h.now, stale: false };
  h.failSend = true;
  assert.throws(() => h.run(), /bridge down/);
  h.failSend = false;
  h.now += 600;
  const second = h.now;
  h.pump = { last_tick: h.now - 400, stale: true };
  assert.equal(h.run(), null);
  assert.deepEqual(h.sent.map(a => a.key), [`coord-pump-heartbeat:${first}:1`]);
  h.now += 300;
  assert.equal(h.run().key, `coord-pump-heartbeat:${second}:1`);
  assert.deepEqual(h.sent.map(a => a.key),
    [`coord-pump-heartbeat:${first}:1`, `coord-pump-heartbeat:${first}:ok`, `coord-pump-heartbeat:${second}:1`]);
});

test('a recovery note queued behind a failed alert is replaced once the new outage is confirmed', () => {
  const h = harness();
  const first = h.now;
  h.run();
  h.now += 300;
  h.failSend = true;
  assert.throws(() => h.run(), /bridge down/);
  h.now += 300;
  h.pump = { last_tick: h.now, stale: false };
  assert.throws(() => h.run(), /bridge down/);
  assert.equal(h.state.outbox.length, 2);
  h.failSend = false;
  h.now += 600;
  const second = h.now;
  h.pump = { last_tick: h.now - 400, stale: true };
  assert.equal(h.run(), null);
  assert.deepEqual(h.sent, []);
  h.now += 300;
  assert.equal(h.run().key, `coord-pump-heartbeat:${second}:1`);
  assert.deepEqual(h.sent.map(a => a.key), [`coord-pump-heartbeat:${first}:1`, `coord-pump-heartbeat:${second}:1`]);
});

test('an outage that flaps while Telegram is down keeps two alerts: the one being tried and the newest', () => {
  const h = harness();
  h.run();
  h.now += 300;
  h.failSend = true;
  assert.throws(() => h.run(), /bridge down/);
  const head = structuredClone(h.state.outbox[0]);
  for (let i = 0; i < 100; i++) {
    h.now += 300;
    h.pump = { last_tick: h.now, stale: false };
    assert.throws(() => h.run(), /bridge down/);
    h.now += 600;
    h.pump = { last_tick: h.now - 400, stale: true };
    assert.equal(h.run(), null);
    h.now += 300;
    assert.throws(() => h.run(), /bridge down/);
    assert.ok(h.state.outbox.length <= 2);
    assert.deepEqual(h.state.outbox[0], head);
  }
  const last = h.state.staleSince;
  h.failSend = false;
  h.now += 300;
  h.pump = { last_tick: h.now, stale: false };
  assert.equal(h.run().key, `coord-pump-heartbeat:${last}:ok`);
  assert.deepEqual(h.sent.map(a => a.key), [head.key, `coord-pump-heartbeat:${last}:ok`]);
  assert.deepEqual(h.state, {});
});

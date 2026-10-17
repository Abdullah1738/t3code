import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as C from '../lib/coord.mjs';
import { get } from '../lib/db.mjs';
import { deliver } from '../lib/pump.mjs';
import { fresh, stubControl, resetHooks } from './helpers.mjs';
import { fakeMissions } from './fake-missions.mjs';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const run = promisify(execFile);

let robob = null;
let control = null;
let db = null;

function seed() {
  C.actorSet('master', { thread: 'T-master' });
  C.actorSet('cell-a', { thread: 'T-a' });
  C.actorSet('cell-b', { thread: 'T-b' });
  C.actorSet('crw', { kind: 'process' });
  C.channelCreate('delivery', { owner: 'master' });
  C.channelCreate('control', { owner: 'master' });
  C.memberAdd('delivery', 'master', { wake: true });
  C.memberAdd('delivery', 'cell-a', { wake: true });
  C.memberAdd('delivery', 'cell-b');
  C.memberAdd('control', 'master', { wake: true });
  C.memberAdd('control', 'crw');
}

beforeEach(async () => {
  db = fresh();
  resetHooks();
  seed();
  robob = await fakeMissions();
  C.messagingTarget(robob.cfg);
  control = await stubControl({ states: { 'T-master': 'idle', 'T-a': 'idle', 'T-b': 'idle' } });
});

afterEach(async () => {
  C.messagingTarget(null);
  await robob.close();
  await control.close();
  C.close();
});

const toRobob = () => C.setMessaging('robob', { as: 'master', mission: 'crpko', reason: 'cutover test' });
const countEvents = () => get('SELECT COUNT(*) n FROM events').n;

// The same script of calls, each result captured; refusals become {refused: code, ...extra}.
async function script() {
  const out = [];
  const step = async (name, fn) => {
    try { out.push([name, await fn()]); } catch (e) { out.push([name, { refused: e.code, ...e.extra }]); }
  };
  await step('post cell-a status', () => C.post('delivery', { as: 'cell-a', kind: 'status', key: 'k1', summary: 'half way', work: 'CRP-1' }));
  await step('post master control to crw', () => C.post('control', { as: 'master', kind: 'control', key: 'k2', summary: 'hold merges', to: 'crw,cell-a', body: { why: 'usage' } }));
  await step('repeat k1 same body', () => C.post('delivery', { as: 'cell-a', kind: 'status', key: 'k1', summary: 'half way', work: 'CRP-1' }));
  await step('repeat k1 other body', () => C.post('delivery', { as: 'cell-a', kind: 'status', key: 'k1', summary: 'done' }));
  await step('unknown channel', () => C.post('nope', { as: 'master', kind: 'status', key: 'k3', summary: 's' }));
  await step('unknown recipient', () => C.post('delivery', { as: 'master', kind: 'request', key: 'k4', summary: 's', to: ['ghost'] }));
  await step('bad kind', () => C.post('delivery', { as: 'master', kind: 'chat', key: 'k5', summary: 's' }));
  await step('reply', () => C.post('delivery', { as: 'master', kind: 'decision', key: 'k6', summary: 'go', replyTo: 1, to: ['cell-a'] }));
  await step('inbox master', () => C.inbox({ as: 'master' }));
  await step('inbox cell-a unacked', () => C.inbox({ as: 'cell-a', unacked: true }));
  await step('inbox crw', () => C.inbox({ as: 'crw', unacked: true, limit: 1000 }));
  await step('ack cell-a by seq and key', () => C.ack('cell-a', ['2', 'k6']));
  await step('ack cell-a again', () => C.ack('cell-a', [2]));
  await step('ack not addressed', () => C.ack('cell-b', ['k2']));
  await step('ack missing', () => C.ack('master', ['99']));
  await step('inbox cell-a unacked after ack', () => C.inbox({ as: 'cell-a', unacked: true }));
  await step('inbox cell-a after 1', () => C.inbox({ as: 'cell-a', after: 1 }));
  return out;
}

test('forward on/off round trip: post, inbox and ack give the same results', async () => {
  const coordRun = await script();
  // A second, identical DB in robob mode: every call goes to the missions API and none touch coord.db's events.
  C.close();
  fresh();
  seed();
  await robob.close();
  robob = await fakeMissions();
  C.messagingTarget(robob.cfg);
  toRobob();
  const robobRun = await script();
  assert.deepEqual(robobRun, coordRun);
  assert.equal(countEvents(), 0, 'robob mode writes no coord events');
  assert.equal(robob.messages.length, 3);
  // Shapes crw relies on (attention reads control rows that were skipped for the pull-only crw actor).
  const crw = coordRun.find(([n]) => n === 'inbox crw')[1].events;
  assert.deepEqual(crw.map(e => [e.channel_id, e.delivery, e.kind, e.sender, typeof e.created_at]), [['control', 'skipped', 'control', 'master', 'number']]);
});

test('robob mode: every call is forwarded with the mission, coord hash and coord fields', async () => {
  toRobob();
  const r = await C.post('delivery', { as: 'cell-a', kind: 'evidence', key: 'e1', summary: 'deployed', work: 'CRP-9', env: 'DEV', rev: '3', authority: 'run 7', body: 'text' });
  assert.deepEqual(r, { seq: 1, recipients: ['cell-b', 'master'] });
  const [p] = robob.requests;
  assert.equal(p.path, '/api/ardud/missions/coord/post');
  assert.equal(p.body.mission, 'crpko');
  assert.equal(p.body.env, 'dev', 'env is canonicalised before forwarding');
  assert.equal(p.body.hash, C.hash({ channel: 'delivery', kind: 'evidence', sender: 'cell-a', work: 'CRP-9', env: 'dev', rev: '3', authority: 'run 7', summary: 'deployed', body: 'text', reply_to: undefined, to: null }));
  await C.inbox({ as: 'master', unacked: true });
  assert.deepEqual(robob.requests[1].query, { mission: 'crpko', as: 'master', unacked: '1', after: '0', limit: '100' });
  await C.ack('master', [1]);
  assert.deepEqual(robob.requests[2].body, { mission: 'crpko', as: 'master', refs: ['1'] });
  // Local refusals still happen before any request.
  await assert.rejects(async () => C.post('delivery', { as: 'cell-a', kind: 'status', summary: 'no key' }), e => e.code === 'invalid');
  assert.equal(robob.requests.length, 3);
});

test('robob mode: the pump rings nobody, and post skips the delivery nudge', async () => {
  C.post('delivery', { as: 'master', kind: 'request', key: 'before', summary: 'queued before cutover' });
  toRobob();
  const r = await deliver({ cfg: control.cfg });
  assert.equal(control.sends.length, 0);
  assert.deepEqual(r.messaging, { mode: 'robob', mission: 'crpko' });
  assert.equal(get("SELECT status FROM deliveries WHERE recipient='cell-a'").status, 'pending', 'coord deliveries are left as they were');
  const a = C.attention();
  assert.deepEqual([a.unacked, a.pending_overdue, a.failed_deliveries], [[], [], []]);
  assert.equal(a.messaging.mode, 'robob');
  assert.equal((await C.drainReport({ threadState: async () => 'idle' })).inflight.deliveries, 0);
});

test('rollback: messaging=coord restores coord.db messaging and pump rings', async () => {
  toRobob();
  await C.post('delivery', { as: 'master', kind: 'request', key: 'during', summary: 'sent while forwarded' });
  assert.equal(countEvents(), 0);
  assert.deepEqual(C.setMessaging('coord', { as: 'master', reason: 'rollback' }).mode, 'coord');
  const r = C.post('delivery', { as: 'master', kind: 'request', key: 'after', summary: 'back on coord' });
  assert.ok(!(r instanceof Promise), 'coord mode stays synchronous');
  assert.deepEqual(r, { seq: 1, recipients: ['cell-a', 'cell-b'] });
  assert.equal(C.inbox({ as: 'cell-a' }).events.length, 1);
  await deliver({ cfg: control.cfg });
  assert.deepEqual(control.sends.map(s => s.thread), ['T-a']);
  assert.equal(robob.requests.length, 1, 'nothing else reached Robob after rollback');
  // The mission stays recorded for a later re-cutover.
  assert.equal(C.messaging().mission, 'crpko');
});

test('robob mode leaves claims, QA windows and flags on coord.db', async () => {
  toRobob();
  const c = C.claim('svc:trading-core', { as: 'cell-a', env: 'dev', ttl: '30m', purpose: 'deploy' });
  assert.throws(() => C.claim('svc:trading-core', { as: 'cell-b', env: 'dev' }), e => e.code === 'held');
  assert.equal(C.claims({ owner: 'cell-a' }).claims.length, 1);
  C.release('svc:trading-core', { as: 'cell-a', fence: c.fence, note: 'run 1' });
  const q = C.qaOpen({ as: 'cell-a', env: 'dev', footprint: 'svc:edge-api', ttl: '1h' });
  C.qaClose(q.release.id, { as: 'cell-a', note: 'run 2' });
  C.setFlag('tf_full_root_blocked', true, { as: 'master' });
  C.setMode('pause', { as: 'master', reason: 'test' });
  assert.equal(C.gate().mode, 'pause');
  assert.equal(robob.requests.length, 0, 'no claim/QA/flag/mode traffic is forwarded');
});

test('switching messaging: master only, robob needs a mission, mode shows in status', async () => {
  assert.throws(() => C.setMessaging('robob', { as: 'cell-a', mission: 'crpko' }), e => e.code === 'forbidden');
  assert.throws(() => C.setMessaging('robob', { as: 'master' }), e => e.code === 'mission_required');
  assert.throws(() => C.setMessaging('slack', { as: 'master' }), e => e.code === 'invalid');
  assert.equal(C.messaging().mode, 'coord');
  toRobob();
  assert.deepEqual([C.status().messaging.mode, C.status().messaging.mission, C.status().messaging.set_by], ['robob', 'crpko', 'master']);
});

test('robob mode: Robob down refuses with messaging_unavailable and writes nothing locally', async () => {
  toRobob();
  robob.setDown(true);
  await assert.rejects(C.post('delivery', { as: 'master', kind: 'status', key: 'x', summary: 's' }), e => e.code === 'messaging_unavailable');
  await assert.rejects(C.inbox({ as: 'master' }), e => e.code === 'messaging_unavailable');
  assert.equal(countEvents(), 0);
  robob.setDown(false);
  // A retry under the same key lands once.
  assert.deepEqual(await C.post('delivery', { as: 'master', kind: 'status', key: 'x', summary: 's' }), { seq: 1, recipients: ['cell-a', 'cell-b'] });
});

test('CLI: messaging switch, then post/inbox/ack go to Robob through the control config', async () => {
  C.close();
  const env = { ...process.env, COORD_DB: db, T3_CONTROL_URL: robob.cfg.url, T3_CONTROL_TOKEN: robob.cfg.token, T3_CONTROL_TOKEN_FILE: '/nonexistent' };
  const cli = async (...args) => {
    try { return JSON.parse((await run(process.execPath, [CLI, ...args], { env })).stdout); } catch (e) { return JSON.parse(e.stdout); }
  };
  assert.equal((await cli('messaging', 'robob', '--as', 'cell-a', '--mission', 'crpko')).error.code, 'forbidden');
  assert.equal((await cli('messaging', 'robob', '--as', 'master', '--mission', 'crpko', '--reason', 'cutover')).messaging.mode, 'robob');
  const p = await cli('post', 'delivery', '--as', 'cell-a', '--kind', 'status', '--key', 'cli-1', '--summary', 'from the cli');
  assert.deepEqual(p, { ok: true, seq: 1, recipients: ['cell-b', 'master'] });
  const conflict = await cli('post', 'delivery', '--as', 'cell-a', '--kind', 'status', '--key', 'cli-1', '--summary', 'changed');
  assert.deepEqual([conflict.ok, conflict.error.code, conflict.error.seq], [false, 'conflict', 1]);
  const ib = await cli('inbox', '--as', 'master', '--unacked');
  assert.deepEqual(ib.events.map(e => [e.seq, e.summary, e.delivery]), [[1, 'from the cli', 'pending']]);
  assert.deepEqual(await cli('ack', '--as', 'master', '1'), { ok: true, acked: [{ seq: 1 }] });
  assert.deepEqual((await cli('messaging')).messaging.mode, 'robob');
  C.open(db);
  assert.equal(countEvents(), 0);
});

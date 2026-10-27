import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as C from '../lib/coord.mjs';
import { get, run as sql } from '../lib/db.mjs';
import { deliver } from '../lib/pump.mjs';
import { fresh, stubControl, resetHooks } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const run = promisify(execFile);

let control = null;
let db = null;

function seed() {
  C.actorSet('master', { thread: 'T-master' });
  C.actorSet('cell-a', { thread: 'T-a' });
  C.actorSet('cell-b', { thread: 'T-b' });
  C.channelCreate('delivery', { owner: 'master' });
  C.memberAdd('delivery', 'master', { wake: true });
  C.memberAdd('delivery', 'cell-a', { wake: true });
  C.memberAdd('delivery', 'cell-b');
}

// A coord.db from before the missions removal: control rows written by the old `coord messaging robob`.
function legacyRobobRows() {
  for (const [k, v] of [['messaging', 'robob'], ['messaging:mission', 'crpko']])
    sql('INSERT INTO control (k,v,set_by,set_at,reason) VALUES (?,?,?,?,?)', k, v, 'master', 1, 'cutover');
}

beforeEach(async () => {
  db = fresh();
  resetHooks();
  seed();
  control = await stubControl({ states: { 'T-master': 'idle', 'T-a': 'idle', 'T-b': 'idle' } });
});

afterEach(async () => {
  await control.close();
  C.close();
});

test('a legacy messaging=robob row falls back to coord.db messaging and the pump rings', async () => {
  legacyRobobRows();
  const m = C.messaging();
  assert.equal(m.mode, 'coord');
  assert.equal(m.retired, 'robob');
  const r = C.post('delivery', { as: 'master', kind: 'request', key: 'k1', summary: 'local again' });
  assert.ok(!(r instanceof Promise), 'post is synchronous on coord.db');
  assert.deepEqual(r, { seq: 1, recipients: ['cell-a', 'cell-b'] });
  assert.deepEqual(C.inbox({ as: 'cell-a' }).events.map(e => e.summary), ['local again']);
  assert.deepEqual(C.ack('cell-a', ['k1']), { acked: [{ seq: 1 }] });
  const d = await deliver({ cfg: control.cfg });
  assert.equal(d.messaging, undefined);
  assert.equal((await C.drainReport({ threadState: async () => 'idle' })).inflight.deliveries, 0);
  assert.equal(C.attention().messaging, undefined);
});

test('switching messaging: master only, coord is the only mode, and it clears the retired rows', () => {
  legacyRobobRows();
  assert.throws(() => C.setMessaging('coord', { as: 'cell-a' }), e => e.code === 'forbidden');
  assert.throws(() => C.setMessaging('robob', { as: 'master' }), e => e.code === 'invalid');
  assert.equal(C.status().messaging.retired, 'robob');
  const m = C.setMessaging('coord', { as: 'master', reason: 'missions retired' });
  assert.deepEqual([m.mode, m.retired, m.set_by], ['coord', undefined, 'master']);
  assert.equal(get("SELECT v FROM control WHERE k='messaging:mission'"), undefined);
});

test('CLI: a legacy robob row warns once on stderr and post/inbox/ack stay local', async () => {
  legacyRobobRows();
  C.close();
  const env = { ...process.env, COORD_DB: db, T3_CONTROL_URL: control.cfg.url, T3_CONTROL_TOKEN: control.cfg.token, COORD_CONTROL_TOKEN_FILE: '/nonexistent' };
  const cli = async (...args) => {
    try {
      const r = await run(process.execPath, [CLI, ...args], { env });
      return { out: JSON.parse(r.stdout), err: r.stderr };
    } catch (e) { return { out: JSON.parse(e.stdout), err: e.stderr }; }
  };
  const p = await cli('post', 'delivery', '--as', 'cell-a', '--kind', 'status', '--key', 'cli-1', '--summary', 'from the cli', '--no-deliver');
  assert.deepEqual(p.out, { ok: true, seq: 1, recipients: ['cell-b', 'master'] });
  assert.equal(p.err.match(/messaging=robob is retired/g)?.length, 1);
  const ib = await cli('inbox', '--as', 'master', '--unacked');
  assert.deepEqual(ib.out.events.map(e => [e.seq, e.summary]), [[1, 'from the cli']]);
  assert.deepEqual((await cli('ack', '--as', 'master', '1')).out, { ok: true, acked: [{ seq: 1 }] });
  assert.equal((await cli('messaging', 'robob', '--as', 'master')).out.error.code, 'invalid');
  const cleared = await cli('messaging', 'coord', '--as', 'master', '--reason', 'retired');
  assert.equal(cleared.out.messaging.mode, 'coord');
  assert.equal((await cli('messaging')).err, '', 'no warning once the row is cleared');
});

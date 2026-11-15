import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, assertReplicaFresh, assertThreadInReplica } from '../lib/io.mjs';
import { registerReplica, guardReplica, MAX_REPLICA_AGE_MS } from '../lib/readonly-db.mjs';
import { timedScan } from '../lib/logging.mjs';
import { act, recoveryScan, scan } from '../cli.mjs';
import { restartScan } from '../lib/restartwatch.mjs';
import { fixture } from '../../router-logging/test/support.mjs';
import { assertScanProps } from './scan-props.mjs';

const NOW = Date.parse('2026-11-15T10:00:00Z');
const invalid = [
  ['ready', '0'], ['ready', '2'], ['ready', null],
  ['schema_version', '2'], ['schema_version', null],
  ['updated_at', 'not-a-date'], ['updated_at', '2026-11-15T09:59:59'], ['updated_at', null],
];

function replica(t) {
  t.mock.method(Date, 'now', () => NOW);
  const dir = mkdtempSync(join(tmpdir(), 'replica-failures-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'replica.sqlite');
  const writer = new DatabaseSync(path);
  t.after(() => writer.close());
  writer.exec('pragma journal_mode=wal');
  writer.exec('create table ardud_readonly_meta(key text primary key, value text not null)');
  for (const [key, value] of Object.entries({ ready:'1', schema_version:'1',
    updated_at:new Date(NOW - 1_000).toISOString(), generation:'42' })) {
    writer.prepare('insert into ardud_readonly_meta values (?,?)').run(key, value);
  }
  const set = (key, value) => value === null
    ? writer.prepare('delete from ardud_readonly_meta where key=?').run(key)
    : writer.prepare('update ardud_readonly_meta set value=? where key=?').run(value, key);
  return { path, writer, set };
}

for (const lane of ['stream', 'restart']) for (const stage of ['open', 'mid-scan']) {
  for (const [key, value] of invalid) test(`${lane} logs ${key}=${value} at ${stage} as REPLICA_NOT_READY`, async t => {
    const { rows } = fixture(t);
    const { path, writer, set } = replica(t);
    await assert.rejects(timedScan(lane, { openDb }, async io => {
      if (stage === 'open') { set(key, value); return io.openDb(path); }
      // Exercise the guard's recheck directly; normal openDb snapshots stay pinned.
      registerReplica(writer, path);
      const guarded = guardReplica(writer);
      const statement = guarded.prepare('select 1');
      set(key, value);
      statement.get();
    }), error => error.code === 'REPLICA_NOT_READY');
    const row = rows().find(row => row.name === `${lane}.scan`);
    assert.equal(row.ok, false);
    assert.equal(row.error.tag, 'REPLICA_NOT_READY');
    assert.equal(row.props.replicaGeneration, 42);
    assert.equal(row.props.replicaAgeMs, key === 'updated_at' ? 'unknown' : 1_000);
  });
}

test('stale and future snapshots retain REPLICA_UNAVAILABLE and their pinned generation/age', async t => {
  const { rows } = fixture(t);
  const { path, set } = replica(t);
  for (const age of [MAX_REPLICA_AGE_MS + 1, -5_001]) {
    set('updated_at', new Date(NOW - age).toISOString());
    await assert.rejects(timedScan('stream', {openDb}, io => io.openDb(path)), error => error.code === 'REPLICA_UNAVAILABLE');
    const row = rows().filter(row => row.name === 'stream.scan').at(-1);
    assert.equal(row.error.tag, 'REPLICA_UNAVAILABLE');
    assert.equal(row.props.replicaGeneration, 42);
    assert.equal(row.props.replicaAgeMs, age);
  }
  set('updated_at', new Date(NOW - MAX_REPLICA_AGE_MS).toISOString());
  const db = openDb(path);
  t.after(() => db.close());
  assert.doesNotThrow(() => assertReplicaFresh(db));
});

test('invalid diagnostic metadata cannot leak through log props or messages', async t => {
  const { rows } = fixture(t);
  const { path, set } = replica(t);
  set('generation', '/home/fixture@example.invalid/sk-private');
  set('updated_at', 'Bearer private');
  await assert.rejects(timedScan('stream', {openDb}, io => io.openDb(path)), error => error.code === 'REPLICA_NOT_READY');
  const row = rows().find(row => row.name === 'stream.scan');
  assert.equal(row.props.replicaGeneration, 'unknown');
  assert.equal(row.props.replicaAgeMs, 'unknown');
  for (const secret of ['fixture@example.invalid', 'sk-private', 'Bearer private']) assert.ok(!JSON.stringify(rows()).includes(secret));
});

test('a not-ready export reopened mid-scan tags both lanes and leaves recovery pending', async t => {
  const { rows } = fixture(t);
  const { path, set } = replica(t);
  const state = { handled:{}, servers:[], lastScan:new Date(NOW - 60_000).toISOString() };
  const before = structuredClone(state);
  const io = { PATHS:{db:path}, openDb, assertReplicaFresh,
    serverRuntime:() => null, openCodeRuntime:() => null,
    cancelledSubagentsSince:() => { set('ready', '0'); return []; },
    cancelledDelegatedTasksSince:() => assert.fail('must defer before next query'),
    sendToThread:() => assert.fail('must not send'), telegram:() => assert.fail('must not notify'),
  };
  await assert.rejects(timedScan('stream', io, timed => recoveryScan({
    opts:{dryRun:false,maxAgeHours:6}, state, now:NOW,
  }, timed)), error => error.code === 'REPLICA_NOT_READY');
  for (const lane of ['stream', 'restart']) {
    const row = rows().find(row => row.name === `${lane}.scan`);
    assert.equal(row.error.tag, 'REPLICA_NOT_READY');
    assertScanProps(row.props, {replicaGeneration:42,replicaAgeMs:1_000,deferredThreads:0,maxThreadAheadMs:'unknown',phase:'openDb'});
  }
  assert.deepEqual(state, before);
});

for (const [lane, stage] of [['stream','gather'], ['stream','act'], ['restart','act']]) for (const [updatedAt, ahead] of [
  [new Date(NOW + 500).toISOString(), 1_500], [undefined, 'unknown'], ['not-a-date', 'unknown'],
]) test(`${lane} ${stage} defers timestamp ${updatedAt}, recovers another thread and retries later`, async t => {
  const { rows } = fixture(t);
  const { path } = replica(t);
  const at = NOW - 120_000;
  const id = lane === 'restart' ? 'rs-fixture' : 'fixture';
  const thread = { threadId:'t', model:{instanceId:'opencode'}, nativeSessionId:'ses_t',
    latestRunId:'run:1', updatedAt };
  const healthy = {...thread,threadId:'healthy',nativeSessionId:'ses_healthy',updatedAt:new Date(NOW-1_000).toISOString()};
  const incident = { id, startMs:at, endMs:at, failAllMs:at, subagents:[],
    runs:['t','healthy'].map(thread_id => ({thread_id,run_id:'run:1',ordinal:1,completed_at:new Date(at).toISOString()})) };
  const state = { handled:{[id]:{incident, attempts:1, threads:{t:{failures:1}}}}, servers:[] };
  state.lastStallScan = new Date(NOW).toISOString();
  const sent = [];
  const notifications = [];
  const noMutation = () => assert.fail('replica deferral must not mutate or notify');
  const io = {
    PATHS:{db:path}, openDb, assertReplicaFresh, assertThreadInReplica,
    harnessCutoverStatus:async () => ({active:false,completed:false,claimedThreadIds:[],claimedRunIds:[]}),
    serverRuntime:() => null, openCodeRuntime:() => null,
    cancelledSubagentsSince:() => [], cancelledDelegatedTasksSince:() => [], restartRunsSince:() => [],
    failedRunsSince:() => [], failedSubagentsSince:() => [], laterRuns:() => [], queuedRuns:() => [],
    activeSessions:async () => new Set(), getThread:async id => id === 't' ? thread : healthy,
    ocSession:async () => null, ocMessages:async () => ({messages:[],complete:true}), ocForms:async () => [],
    threadMessageIdsSince:() => [], runMessages:() => [],
    robobHealthy:async () => true, restartNoteRun:() => null, stoppedSince:() => false,
    now:() => NOW, acquireLock:() => () => {}, loadState:() => state,
    saveState:() => {}, sendToThread:async id => { sent.push(id); }, dispatchCommand:noMutation,
    telegram:args => { notifications.push(args); },
  };
  const db = openDb(path);
  t.after(() => db.close());
  if (stage === 'gather') io.laterRuns = (snapshot, id) => {
    if (id === 't') assertThreadInReplica(snapshot, thread);
    return [];
  };
  const run = lane === 'stream'
      ? () => scan({maxAgeHours:6}, io)
      : () => restartScan({db,state,now:NOW,sinceIso:new Date(at).toISOString(),floorMs:at-1,log:() => {}}, io);
  for (let attempt = 0; attempt < 2; attempt++) {
    await run();
    const row = rows().filter(row => row.name === `${lane}.scan`).at(-1);
    assert.equal(row.ok, true);
    assert.equal(row.error, undefined);
    assertScanProps(row.props, {deferredThreads:1,maxThreadAheadMs:ahead});
    const deferral = rows().filter(row => row.name === 'thread.deferred').at(-1);
    assert.deepEqual(deferral.error, {tag:'REPLICA_BEHIND_THREAD',message:'thread is newer than Robob replica; recovery deferred'});
    assert.deepEqual(deferral.props, {replicaGeneration:42,replicaAgeMs:1_000,threadAheadMs:ahead});
    const entry = state.handled[id];
    assert.equal(entry.attempts, 1);
    assert.deepEqual(entry.threads.t, {failures:1});
    assert.ok(!entry.done);
    assert.deepEqual(sent, ['healthy']);
    assert.equal(notifications.length, 0);
  }
  thread.updatedAt = new Date(NOW-1_000).toISOString();
  await run();
  assert.deepEqual(sent, ['healthy','t']);
  assert.equal(state.handled[id].done, true);
  assert.equal(notifications.length, 1);
  assertScanProps(rows().filter(row => row.name === `${lane}.scan`).at(-1).props,
    {deferredThreads:0,maxThreadAheadMs:'unknown'});
});

for (const code of ['REPLICA_UNAVAILABLE', 'REPLICA_NOT_READY', 'REPLICA_BEHIND_THREAD']) test(`stream action defers ${code} without recording progress`, async t => {
  fixture(t);
  const progress = {};
  const g = { plan:{threadId:'t',action:'note'}, sourceRuns:[], lost:[], reply:null, forms:[] };
  const io = {
    harnessCutoverStatus:async () => ({active:false,completed:false,claimedThreadIds:[],claimedRunIds:[]}),
    assertReplicaFresh:() => { throw Object.assign(new Error('replica deferred'), {code}); },
    getThread:() => assert.fail('must not continue'), sendToThread:() => assert.fail('must not send'),
  };
  await assert.rejects(act({db:{},incident:{id:'fixture'},g,progress,save:() => assert.fail('must not save')}, io), error => error.code === code);
  assert.deepEqual(progress, {});
});

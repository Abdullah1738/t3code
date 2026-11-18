import './log-dir.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoveryScan } from '../cli.mjs';
import { openDb, assertReplicaFresh } from '../lib/io.mjs';
import { fixture } from '../../router-logging/test/support.mjs';
import { timedScan } from '../lib/logging.mjs';

for (const throws of [false, true]) test(`nested restart scan times database reopens on ${throws ? 'failure' : 'success'}`, async t => {
  const { rows } = fixture(t);
  let clock = 0, opens = 0, closes = 0;
  t.mock.method(performance, 'now', () => clock);
  const error = Object.assign(new Error('Robob replica is not ready'), {code:'REPLICA_NOT_READY'});
  const io = {
    PATHS:{db:'fixture'},
    openDb:() => {
      opens++;
      clock += opens === 2 ? 37 : 1;
      if (throws && opens === 2) throw error;
      return {close(){closes++;}};
    },
    assertReplicaFresh() {}, serverRuntime:() => {clock += 5; return null;}, openCodeRuntime:() => null,
    cancelledSubagentsSince:() => [], cancelledDelegatedTasksSince:() => [], restartRunsSince:() => [],
    failedRunsSince:() => [], failedSubagentsSince:() => [],
  };
  const scan = timedScan('stream', io, timed => recoveryScan({
    opts:{dryRun:true,seed:true,maxAgeHours:6},state:{handled:{},servers:[]},now:Date.now(),
  }, timed));
  if (throws) await assert.rejects(scan, e => e === error); else await scan;
  for (const lane of ['stream', 'restart']) {
    const row = rows().find(row => row.name === `${lane}.scan`);
    assert.equal(row.ok, !throws);
    assert.equal(row.props.longestSyncOp, 'openDb');
    assert.equal(row.props.longestSyncMs, 37);
    assert.equal(typeof row.props.loopBlockMaxMs, 'number');
    if (throws) assert.equal(row.props.phase, 'openDb');
    const phase = rows().find(row => row.name === `${lane}.phase` && row.props.phase === 'openDb');
    assert.equal(phase.props.durationMaxMs, 37);
    assert.equal(phase.props.failed, Number(throws));
  }
  assert.ok(opens >= 2);
  assert.equal(closes, opens - Number(throws));
});

for (const publishing of [true, false]) test(`slow scan with replica publishing=${publishing} preserves the freshness bound`, async t => {
  fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'scan-batches-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'replica.sqlite');
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const writer = new DatabaseSync(path);
  t.after(() => writer.close());
  writer.exec("pragma journal_mode=wal; create table ardud_readonly_meta(key text primary key,value text not null); insert into ardud_readonly_meta values('ready','1'),('schema_version','1')");
  writer.prepare('insert into ardud_readonly_meta values(?,?)').run('updated_at', new Date(clock).toISOString());
  let batches = 0, opens = 0;
  const slow = db => {
    assertReplicaFresh(db);
    const seen = db.prepare("select value from ardud_readonly_meta where key='updated_at'").get().value;
    assert.equal(seen, new Date(clock).toISOString());
    batches++;
    clock += 60_000;
    if (publishing) writer.prepare("update ardud_readonly_meta set value=? where key='updated_at'").run(new Date(clock).toISOString());
    return [];
  };
  const io = {
    PATHS: { db: path },
    openDb: path => { opens++; return openDb(path); },
    assertReplicaFresh, loadStallState: () => ({ stalls: {} }), serverRuntime: () => null, openCodeRuntime: () => null,
    cancelledSubagentsSince: slow, cancelledDelegatedTasksSince: slow, restartRunsSince: slow,
    failedRunsSince: slow, failedSubagentsSince: slow,
    telegram: () => assert.fail('must not notify'), sendToThread: () => assert.fail('must not send'),
    saveState: () => assert.fail('must not save dry-run state'),
  };
  const state = {handled:{},servers:[]};
  const run = () => recoveryScan({opts:{dryRun:true,seed:true,maxAgeHours:6},state,now:clock},io);
  if (publishing) {
    const result = await run();
    assert.equal(result.incidents.length, 0);
    assert.equal(batches, 5);
    assert.ok(opens >= 5);
  } else {
    await assert.rejects(run(), e => e.code === 'REPLICA_UNAVAILABLE');
    assert.equal(batches, 1);
  }
  assert.deepEqual(state.handled, {});
});

for (const lane of ['restart', 'stream']) test(`${lane} resolves each slow ancestry traversal in its own snapshot`, async t => {
  fixture(t);
  let clock = Date.now();
  const now = clock, ended = new Date(now - 120_000).toISOString();
  t.mock.method(Date, 'now', () => clock);
  const check = db => {
    if (clock - db.at > 45_000) throw Object.assign(new Error('stale ancestry snapshot'), {code:'REPLICA_UNAVAILABLE'});
  };
  const subs = [0, 1, 2].map(i => ({subagent_id:`sub:${i}`,run_id:`run:${i}`,
    thread_id:`thread:provider:fixture:native-thread:ses_${i}`,completed_at:ended,result:null}));
  let traversals = 0;
  const io = {
    PATHS:{db:'fixture'}, openDb:() => ({at:clock,close(){}}), assertReplicaFresh:check,
    loadStallState: () => ({ stalls: {} }), serverRuntime:() => null, openCodeRuntime:() => null,
    cancelledSubagentsSince:() => lane === 'restart' ? subs : [],
    cancelledDelegatedTasksSince:() => [], restartRunsSince:() => [],
    failedRunsSince:() => lane === 'stream' ? [{run_id:'failed',thread_id:'parent',completed_at:ended,
      error:'The OpenCode event stream was lost and could not reconnect.'}] : [],
    failedSubagentsSince:() => lane === 'stream' ? subs : [],
    subagentParent:db => {check(db);clock+=30_000;traversals++;return 'parent';},
    threadRoot:db => {check(db);return null;}, activeSessions:async () => new Set(), getThread:async () => null,
    sendToThread:() => assert.fail('must not send'), telegram:() => assert.fail('must not notify'),
  };
  await recoveryScan({opts:{dryRun:true,maxAgeHours:6},state:{handled:{},servers:[]},now},io);
  assert.equal(traversals,3);
});

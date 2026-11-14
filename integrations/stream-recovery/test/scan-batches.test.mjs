import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoveryScan } from '../cli.mjs';
import { openDb, assertReplicaFresh } from '../lib/io.mjs';
import { fixture } from '../../router-logging/test/support.mjs';

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
    assertReplicaFresh, serverRuntime: () => null, openCodeRuntime: () => null,
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

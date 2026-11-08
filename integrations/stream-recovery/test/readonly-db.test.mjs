import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, assertReplicaFresh, assertThreadInReplica } from '../lib/io.mjs';
import { assertReplicaPath, MAX_REPLICA_AGE_MS, replicaPath } from '../lib/readonly-db.mjs';

function fixture(t, { ready = 1, updated = new Date().toISOString(), schema = '1' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'recovery-replica-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'replica.sqlite');
  const db = new DatabaseSync(path);
  db.exec('create table ardud_readonly_meta(key text primary key, value text not null)');
  const insert = db.prepare('insert into ardud_readonly_meta values (?,?)');
  for (const [key, value] of Object.entries({ ready: String(ready), updated_at: updated, schema_version: schema })) insert.run(key, value);
  db.close();
  return { home, path };
}

test('replica default and override precedence never select the writer', () => {
  assert.equal(replicaPath({}, '/h'), '/h/.robob/userdata/readonly/state.sqlite');
  assert.equal(replicaPath({ ROBOB_READONLY_DB: '/shared' }), '/shared');
  assert.equal(replicaPath({ ROBOB_READONLY_DB: '/shared', STREAM_RECOVERY_DB: '/own' }), '/own');
});

test('rejects live path, symlink chains and hardlinks before SQLite opens', (t) => {
  const { home } = fixture(t);
  const live = join(home, '.robob/userdata/statev2.sqlite');
  mkdirSync(join(home, '.robob/userdata'), { recursive: true });
  // Not a database: any attempted SQLite connect would report a different error.
  writeFileSync(live, 'do not open');
  const symlink = join(home, 'symlink');
  const chain = join(home, 'chain');
  const hardlink = join(home, 'hardlink');
  symlinkSync(live, symlink);
  symlinkSync(symlink, chain);
  linkSync(live, hardlink);
  for (const path of [live, symlink, chain, hardlink]) {
    assert.throws(() => assertReplicaPath(path, home), /refusing live Robob/);
  }
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    for (const path of [live, symlink, chain, hardlink]) assert.throws(() => openDb(path), /refusing live Robob/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  assert.throws(() => assertReplicaPath(`file:${hardlink}?mode=ro`, home), /filesystem path/);
});

test('configured live homes, legacy state and native OpenCode aliases refuse explicit overrides', (t) => {
  const { home } = fixture(t);
  const env = { HOME: home, ROBOB_HOME: join(home, 'custom-robob'), T3CODE_HOME: '~/custom-t3',
    XDG_DATA_HOME: join(home, 'xdg') };
  const originals = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const roots = [join(home, '.robob'), join(home, '.t3'), env.ROBOB_HOME, join(home, 'custom-t3')];
    const lives = roots.flatMap((root) => ['statev2.sqlite', 'state.sqlite'].map((name) => join(root, 'userdata', name)));
    lives.push(join(home, '.local/share/opencode/opencode.db'), join(env.XDG_DATA_HOME, 'opencode/opencode.db'));
    for (const [i, live] of lives.entries()) {
      mkdirSync(join(live, '..'), { recursive: true });
      writeFileSync(live, 'not a database; must never connect');
      const sym = join(home, `symlink-${i}`), hard = join(home, `hardlink-${i}`);
      symlinkSync(live, sym);
      linkSync(live, hard);
      for (const path of [live, sym, hard]) {
        assert.throws(() => assertReplicaPath(path, home, env), /refusing live Robob/);
        assert.throws(() => openDb(path), /refusing live Robob/);
      }
    }
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  // A fixture's basename is not a writer identity.
  const source = fixture(t);
  const innocent = join(source.home, 'statev2.sqlite');
  renameSync(source.path, innocent);
  const db = openDb(innocent);
  db.close();
});

test('fresh ready snapshot opens read-only; missing replica never gets created', (t) => {
  const { path, home } = fixture(t);
  const db = openDb(path);
  t.after(() => db.close());
  assert.doesNotThrow(() => assertReplicaFresh(db));
  assert.equal(db.prepare("select value from ardud_readonly_meta where key='ready'").get().value, '1');
  assert.throws(() => db.exec('create table nope(x)'), /readonly/);
  assert.throws(() => openDb(join(home, 'missing.sqlite')), /ENOENT/);
});

test('missing metadata, not-ready, invalid, future and stale snapshots refuse', (t) => {
  for (const options of [{ ready: 0 }, { schema: '2' }, { updated: 'not-a-date' },
    { updated: new Date(Date.now() - MAX_REPLICA_AGE_MS - 1_000).toISOString() },
    { updated: new Date(Date.now() + 60_000).toISOString() }]) {
    const { path } = fixture(t, options);
    assert.throws(() => openDb(path), /not ready|stale/);
  }
  const { path } = fixture(t);
  const db = new DatabaseSync(path);
  db.exec('drop table ardud_readonly_meta');
  db.close();
  assert.throws(() => openDb(path), /no such table/);
});

test('a connection cannot borrow freshness from a replacement export', (t) => {
  const { path } = fixture(t);
  const db = openDb(path);
  t.after(() => db.close());
  const next = fixture(t);
  renameSync(next.path, path);
  assert.throws(() => assertReplicaFresh(db, Date.now() + MAX_REPLICA_AGE_MS + 1_000), /stale/);
});

test('each query checks the cached snapshot and an incomplete export cannot mix in', (t) => {
  const { path } = fixture(t);
  const writer = new DatabaseSync(path);
  writer.exec('pragma journal_mode=wal; create table data(value text); insert into data values (\'complete\')');
  const db = openDb(path);
  t.after(() => { db.close(); writer.close(); });
  writer.exec("update ardud_readonly_meta set value='0' where key='ready'; update data set value='partial'");
  assert.equal(db.prepare('select value from data').get().value, 'complete');
  assert.throws(() => openDb(path), /not ready/);
  const originalNow = Date.now;
  const cached = db.prepare('select value from data');
  Date.now = () => originalNow() + MAX_REPLICA_AGE_MS + 1_000;
  try {
    assert.throws(() => db.prepare('select value from data'), /stale/);
    assert.throws(() => cached.get(), /stale/);
  }
  finally { Date.now = originalNow; }
});

test('a live thread updated after the export is deferred even when its latest run is unchanged', (t) => {
  const { path } = fixture(t);
  const db = openDb(path);
  t.after(() => db.close());
  assert.doesNotThrow(() => assertThreadInReplica(db, { latestRunId: 'run:1', updatedAt: new Date(Date.now() - 10_000).toISOString() }));
  assert.throws(() => assertThreadInReplica(db, { latestRunId: 'run:1', updatedAt: new Date(Date.now() + 1).toISOString() }), /newer than Robob replica/);
  assert.throws(() => assertThreadInReplica(db, {}), /newer than Robob replica/);
});

// Regression tests for review r7 of 7c0e39871f (R7-<N> in the test name).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as C from '../lib/coord.mjs';
import * as D from '../lib/db.mjs';
import { fresh, advance, stubControl, SHA0, SHA1, resetHooks, tagFor } from './helpers.mjs';

const TC = 'Equicom-Crypto/trading-core';
const ok = async () => ({ ok: true });
const refused = (fn, code) => assert.rejects(async () => fn(), e => { assert.equal(e.code, code, `${e.code}: ${e.message}`); return true; });
const throwsCode = (fn, code) => assert.throws(fn, e => { assert.equal(e.code, code, `${e.code}: ${e.message}`); return true; });
const svc = (key, o = {}) => C.releaseRequest({ as: 'crw', key, kind: 'service_release', env: 'dev', repo: TC, binary: 'trading-core',
  sha: SHA1, runtimeSha: SHA0, contentPrs: ['equicom-crypto/trading-core#141'], ...o, n: undefined, tag: o.tag ?? tagFor(o.binary, o.n ?? 33) }).release;
const admit = async (r, o = {}) => (await C.releaseAdmit(r.id, { as: 'release', manual: true, verify: ok, ...o })).release;
const start = async (r, o = {}) => (await C.releaseStart(r.id, { as: 'release', fence: r.fence, verify: ok, ...o })).release;

let stub, dbPath;
beforeEach(async () => {
  dbPath = fresh();
  resetHooks();
  stub = await stubControl({ states: {} });
});
afterEach(async () => { await stub.close(); C.close(); });

// ---------- R7-1 ----------

test('R7-1 a mixed-case repo claim is the same resource as the release repo lock, both orders', async () => {
  const c = C.claim(`repo:${TC}`, { as: 'cell:manual', env: 'dev', op: 'direct repo deployment' });
  assert.equal(c.resource, 'repo:equicom-crypto/trading-core');
  await refused(() => admit(svc('a')), 'claimed');
  C.release('repo:EQUICOM-CRYPTO/Trading-Core', { as: 'cell:manual', fence: c.fence });
  const r = await start(await admit(svc('b')));
  assert.equal(r.state, 'running');
  throwsCode(() => C.claim(`repo:${TC}`, { as: 'cell:manual', env: 'dev' }), 'release_in_flight');
});

test('R7-1 mixed-case and lowercase repo claims cannot both be held', () => {
  const a = C.claim(`repo:${TC}`, { as: 'cell:a', env: 'dev' });
  throwsCode(() => C.claim('repo:equicom-crypto/trading-core', { as: 'cell:b', env: 'dev' }), 'held');
  assert.equal(C.check('repo:equicom-crypto/TRADING-CORE', { as: 'cell:a', fence: a.fence }).fence, a.fence);
  C.renew('Repo:Equicom-Crypto/trading-core', { as: 'cell:a', fence: a.fence });
  assert.equal(C.claims({}).claims.filter(x => x.resource.startsWith('repo:')).length, 1);
});

test('R7-1 an expired mixed-case repo claim blocks release admission until reconciled with its fence', async () => {
  C.claim(`repo:${TC}`, { as: 'cell:a', env: 'dev', ttl: '1s' });
  advance(2);
  await refused(() => admit(svc('c')), 'reconcile_required');
  C.reconcile('repo:Equicom-Crypto/Trading-Core', { as: 'master', fence: 1, outcome: 'done', evidence: 'deploy finished' });
  assert.equal((await admit(svc('d'))).state, 'admitted');
});

test('R7-1 resource keys are canonical or refused; footprints and claim_free deps use the same keys', () => {
  assert.equal(C.canonicalResource('SVC:Trading-Core'), 'svc:trading-core');
  assert.equal(C.canonicalResource('tf:Dev-Core-Capacity'), 'tf:dev-core-capacity');
  assert.equal(C.canonicalResource('env:DEV'), 'env:dev');
  assert.equal(C.canonicalResource('pr:Equicom-Crypto/Edge-API#12'), 'pr:equicom-crypto/edge-api#12');
  assert.equal(C.canonicalResource('ticket:CRP-1'), 'ticket:CRP-1');
  for (const k of ['repo:', 'repo:only-owner', 'repo:a/b/c', 'svc:Trading Core', 'svc:', 'tf:dev root', 'nokind', ':x', 'pr:a/b', 'svc:a\nb', 'ch:'])
    throwsCode(() => C.canonicalResource(k), 'resource_invalid');
  throwsCode(() => C.claim('repo:bad', { as: 'cell:a', env: 'dev' }), 'resource_invalid');
  const r = svc('e', { footprint: ['SVC:Edge-API', `repo:${TC}`] });
  assert.deepEqual(r.footprint, ['env:dev', 'repo:equicom-crypto/trading-core', 'svc:edge-api', 'svc:trading-core']);
  const d = C.depAdd('w', 'claim_free', `repo:${TC}`).dep;
  assert.equal(d.ref, 'repo:equicom-crypto/trading-core');
});

test('R7-1 the CLI canonicalizes resource keys', () => {
  C.close();
  const cli = (...args) => JSON.parse(spawnSync(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), ...args],
    { env: { ...process.env, COORD_DB: dbPath }, encoding: 'utf8' }).stdout);
  assert.equal(cli('claim', `repo:${TC}`, '--as', 'cell:a', '--env', 'dev').resource, 'repo:equicom-crypto/trading-core');
  assert.equal(cli('claim', 'repo:equicom-crypto/trading-core', '--as', 'cell:b', '--env', 'dev').error.code, 'held');
  assert.equal(cli('check', 'repo:EQUICOM-crypto/trading-core', '--as', 'cell:a', '--fence', '1').fence, 1);
  assert.equal(cli('claim', 'repo:bad', '--as', 'cell:a', '--env', 'dev').error.code, 'resource_invalid');
  C.open(dbPath);
});

test('R7-1 stored non-canonical keys are normalized on open; aliases that would merge refuse to open', () => {
  C.close();
  const raw = new DatabaseSync(dbPath);
  raw.exec(`INSERT INTO claims (resource,owner,fence,state,lease_until,env) VALUES ('repo:Equicom-Crypto/Trading-Core','cell:a',1,'active',${2e9},'dev');
    INSERT INTO fences (resource,fence) VALUES ('repo:Equicom-Crypto/Trading-Core',1);
    INSERT INTO claim_history (resource,fence,owner,state) VALUES ('svc:Trading-Core',3,'cell:z','reconciled');`);
  raw.close();
  C.open(dbPath);
  assert.deepEqual(C.claims({}).claims.map(x => x.resource), ['repo:equicom-crypto/trading-core']);
  throwsCode(() => C.claim('repo:equicom-crypto/trading-core', { as: 'cell:b', env: 'dev' }), 'held');
  assert.equal(C.check(`repo:${TC}`, { as: 'cell:a', fence: 1 }).fence, 1);
  C.close();
  const raw2 = new DatabaseSync(dbPath);
  raw2.exec(`INSERT INTO claims (resource,owner,fence,state,lease_until,env) VALUES ('repo:EQUICOM-CRYPTO/trading-core','cell:c',1,'active',${2e9},'dev');`);
  raw2.close();
  throwsCode(() => C.open(dbPath), 'resource_alias_conflict');
  const raw3 = new DatabaseSync(dbPath);
  raw3.exec(`DELETE FROM claims WHERE resource='repo:EQUICOM-CRYPTO/trading-core'`);
  raw3.close();
  C.open(dbPath);
  assert.equal(C.claims({}).claims.length, 1);
});

// ---------- R7-2 ----------

test('guard for R7-2: ensureActor leaves an existing thread actor and its pending deliveries alone', () => {
  C.actorSet('crw', { thread: 'T-crw-owner' });
  C.channelCreate('ops', { owner: 'crw' });
  const { seq } = C.post('ops', { as: 'master', kind: 'request', key: 'k', summary: 's', to: ['crw'] });
  const r = C.ensureActor('crw', { kind: 'process' });
  assert.deepEqual([r.existing, r.actor.kind, r.actor.thread_id], [true, 'thread', 'T-crw-owner']);
  assert.equal(C.inbox({ as: 'crw' }).events.find(e => e.seq === seq).delivery, 'pending');
});

test('R7-2 ensureActor does not overwrite a registration that lands between its lookup and its write', () => {
  // A second connection registers the actor right after ensureActor's first statement on the actors
  // table. If ensureActor is not atomic, that registration lands and is then overwritten. If it is
  // atomic, the competitor cannot write (busy) and ensureActor's own insert stands.
  const other = new DatabaseSync(dbPath);
  other.exec('PRAGMA busy_timeout=0;');
  const db = D.db();
  const prepare = db.prepare.bind(db);
  let competitor = null;
  const compete = () => {
    if (competitor !== null) return;
    try { other.exec(`INSERT INTO actors (id,kind,thread_id,updated_at) VALUES ('crw','thread','T-crw-owner',1)`); competitor = 'won'; }
    catch { competitor = 'busy'; }
  };
  db.prepare = sql => {
    const st = prepare(sql);
    if (/\bactors\b/.test(sql)) for (const m of ['get', 'run', 'all']) {
      const f = st[m].bind(st);
      st[m] = (...a) => { const out = f(...a); compete(); return out; };
    }
    return st;
  };
  let r;
  try { r = C.ensureActor('crw', { kind: 'process' }); } finally { db.prepare = prepare; other.close(); }
  const a = C.status().actors.find(x => x.id === 'crw');
  assert.notEqual(competitor, null, 'the competing registration ran');
  if (competitor === 'won') assert.deepEqual([a.kind, a.thread_id, r.existing], ['thread', 'T-crw-owner', true]);
  else assert.deepEqual([competitor, a.kind, r.created], ['busy', 'process', true]);
});

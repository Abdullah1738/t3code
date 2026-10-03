// Regression tests for review r8 of 1db67a2fbf (R8-<N> in the test name).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as C from '../lib/coord.mjs';
import { fresh, stubControl, SHA0, SHA1, resetHooks, tagFor } from './helpers.mjs';

const TC = 'equicom-crypto/trading-core';
const ok = async () => ({ ok: true });
const refused = (fn, code) => assert.rejects(async () => fn(), e => { assert.equal(e.code, code, `${e.code}: ${e.message}`); return true; });
const throwsCode = (fn, code) => assert.throws(fn, e => { assert.equal(e.code, code, `${e.code}: ${e.message}`); return true; });
const svc = (key, o = {}) => C.releaseRequest({ as: 'crw', key, kind: 'service_release', env: 'dev', repo: TC, binary: 'trading-core',
  sha: SHA1, runtimeSha: SHA0, contentPrs: [`${TC}#141`], ...o, n: undefined, tag: o.tag ?? tagFor(o.binary, o.n ?? 33) }).release;
const admit = async (r, o = {}) => (await C.releaseAdmit(r.id, { as: 'release', manual: true, verify: ok, ...o })).release;
const start = async (r, o = {}) => (await C.releaseStart(r.id, { as: 'release', fence: r.fence, verify: ok, ...o })).release;

let stub, dbPath;
beforeEach(async () => {
  dbPath = fresh();
  resetHooks();
  stub = await stubControl({ states: {} });
});
afterEach(async () => { await stub.close(); C.close(); });
const cli = (...args) => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), ...args], { env: { ...process.env, COORD_DB: dbPath }, encoding: 'utf8' });
  return { status: r.status, out: JSON.parse(r.stdout || 'null') };
};

// ---------- R8-1 ----------

test('R8-1 a QA window opened with DEV is the dev window: claims and releases are refused, both orders', async () => {
  const q = C.qaOpen({ as: 'harness', env: 'DEV' }).release;
  assert.equal(q.environment, 'dev');
  throwsCode(() => C.claim('svc:trading-core', { as: 'crw', env: 'dev' }), 'qa_window_open');
  await refused(() => admit(svc('a', { contentPrs: [`${TC}#141`] })), 'qa_window_open');
  C.qaClose(q.id, { as: 'harness' });
  await start(await admit(svc('b')));
  throwsCode(() => C.qaOpen({ as: 'harness', env: 'DEV' }), 'env_busy');
  throwsCode(() => C.qaOpen({ as: 'harness', env: 'staging' }), 'env_unsupported');
  throwsCode(() => C.qaOpen({ as: 'harness', env: 'dev!' }), 'env_invalid');
});

test('R8-1 a pause or drain on ENV:DEV gates dev claims, through the library and the CLI', () => {
  for (const mode of ['pause', 'drain']) {
    const set = C.setMode(mode, { scope: 'ENV:DEV', as: 'master', reason: 'hold dev' });
    assert.equal(set.key, 'mode:env:dev');
    throwsCode(() => C.claim('ENV:DEV', { as: 'direct' }), mode === 'pause' ? 'paused' : 'draining');
    throwsCode(() => C.claim('svc:trading-core', { as: 'direct', env: 'DEV' }), mode === 'pause' ? 'paused' : 'draining');
    assert.equal(C.gate('Env:Dev').mode, mode);
    C.setMode('run', { scope: 'env:dev', as: 'master' });
  }
  throwsCode(() => C.setMode('pause', { scope: 'env:*', as: 'master' }), 'env_unsupported');
  throwsCode(() => C.setMode('pause', { scope: 'crw team', as: 'master' }), 'scope_invalid');
  C.close();
  assert.equal(cli('pause', '--as', 'master', '--scope', 'ENV:DEV', '--reason', 'hold dev').out.key, 'mode:env:dev');
  const c = cli('claim', 'ENV:DEV', '--as', 'direct');
  assert.deepEqual([c.status, c.out.error?.code], [1, 'paused']);
  const d = cli('claim', 'svc:trading-core', '--as', 'direct', '--env', 'DEV');
  assert.deepEqual([d.status, d.out.error?.code], [1, 'paused']);
  C.open(dbPath);
});

test('R8-1 release, claim and event environments are stored in canonical form', () => {
  assert.equal(svc('c', { env: 'Dev' }).environment, 'dev');
  assert.equal(C.claim('svc:trading-core', { as: 'crw', env: 'DEV' }).env, 'dev');
  assert.equal(C.canonicalEnv(' dev '.trim()), 'dev');
  for (const [v, code] of [['', 'env_required'], ['  ', 'env_required'], [null, 'env_required'], ['*', 'env_unsupported'], ['prod', 'env_unsupported'], ['de v', 'env_invalid'], [7, 'env_invalid']])
    throwsCode(() => C.canonicalEnv(v), code);
  assert.equal(C.canonicalEnv('Ephemeral:QA', { supported: false }), 'ephemeral:qa');
});

// ---------- R8-2 / R8-3 / R8-4: no automatic rewrite of stored state ----------

const raw = sql => { C.close(); const d = new DatabaseSync(dbPath); d.exec(sql); d.close(); };

test('R8-2 a stored non-canonical release footprint refuses to open instead of being merged', async () => {
  await admit(svc('A', { footprint: ['repo:equicom-crypto/edge-api'] }));
  raw(`UPDATE releases SET footprint='["env:dev","repo:Equicom-Crypto/edge-api","repo:equicom-crypto/trading-core","svc:trading-core"]'`);
  throwsCode(() => C.open(dbPath), 'noncanonical_state');
  raw(`UPDATE releases SET footprint='["ENV:DEV","repo:equicom-crypto/edge-api","repo:equicom-crypto/trading-core","svc:trading-core"]'`);
  assert.throws(() => C.open(dbPath), e => e.code === 'noncanonical_state' && /releases 1 footprint="ENV:DEV"/.test(e.message));
});

test('R8-3 a stored non-canonical Terraform root refuses to open; root lookups are canonical', () => {
  C.claim('tf:Dev', { as: 'direct' });
  assert.equal(C.tfRootGen('Dev').gen, C.tfRootGen('dev').gen);
  raw(`INSERT INTO tf_roots (root,gen,bumped_at) VALUES ('Dev',2,1800000020)`);
  assert.throws(() => C.open(dbPath), e => e.code === 'noncanonical_state' && /tf_roots Dev/.test(e.message));
});

test('R8-4 a byte-identical release or QA retry stays idempotent, including mixed-case input', () => {
  const opts = { as: 'crw', key: 'replay', kind: 'service_release', env: 'DEV', repo: 'Equicom-Crypto/Trading-Core', binary: 'trading-core',
    sha: SHA1, runtimeSha: SHA0, contentPrs: [`${TC}#141`], tag: tagFor(), footprint: ['repo:Equicom-Crypto/edge-api', 'PR:Org/Repo#7'] };
  const first = C.releaseRequest(opts).release;
  assert.deepEqual([C.releaseRequest(opts).duplicate, C.releaseRequest(opts).release.id], [true, first.id]);
  C.close();
  C.open(dbPath);
  assert.equal(C.releaseRequest(opts).duplicate, true, 'after reopen too');
  const q = { as: 'harness', env: 'DEV', footprint: ['PR:Org/Repo#7'], key: 'qa-replay' };
  const qa = C.qaOpen(q).release;
  C.close();
  C.open(dbPath);
  assert.deepEqual([C.qaOpen(q).duplicate, C.qaOpen(q).release.id], [true, qa.id]);
});

test('guard for R8-2..4: stored state is never rewritten on open', () => {
  C.claim('svc:trading-core', { as: 'crw', env: 'dev' });
  C.close();
  const d = new DatabaseSync(dbPath);
  const before = JSON.stringify(d.prepare('SELECT * FROM claims').all()) + JSON.stringify(d.prepare('SELECT * FROM releases').all());
  d.close();
  C.open(dbPath);
  C.close();
  const d2 = new DatabaseSync(dbPath);
  assert.equal(JSON.stringify(d2.prepare('SELECT * FROM claims').all()) + JSON.stringify(d2.prepare('SELECT * FROM releases').all()), before);
  d2.close();
  C.open(dbPath);
});

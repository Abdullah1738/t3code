// Regression tests for review r6 of 0b4691934a, one or more per finding (R6-<N> in the test name).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as C from '../lib/coord.mjs';
import * as E from '../lib/evidence.mjs';
import * as P from '../lib/pump.mjs';
import { fresh, advance, stubControl, SHA0, SHA1, fakeGh, deployLog, resetHooks, tagFor } from './helpers.mjs';

const TC = 'equicom-crypto/trading-core';
const ok = async () => ({ ok: true });
const refused = (fn, code) => assert.rejects(async () => fn(), e => { assert.equal(e.code, code, `${e.code}: ${e.message}`); return true; });
const throwsCode = (fn, code) => assert.throws(fn, e => { assert.equal(e.code, code, `${e.code}: ${e.message}`); return true; });
const svc = (key, o = {}) => C.releaseRequest({ as: 'crw', key, kind: 'service_release', env: 'dev', repo: TC, binary: 'trading-core',
  sha: SHA1, runtimeSha: SHA0, contentPrs: [`${TC}#141`], ...o, n: undefined, tag: o.tag ?? tagFor(o.binary, o.n ?? 33) }).release;
const admit = async (r, o = {}) => (await C.releaseAdmit(r.id, { as: 'release', manual: true, verify: ok, ...o })).release;
const start = async (r, o = {}) => (await C.releaseStart(r.id, { as: 'release', fence: r.fence, verify: ok, ...o })).release;
const tf = (key, plan = 'saved:900@1') => C.releaseRequest({ as: 'release', key, kind: 'tf_apply', env: 'dev', plan }).release;
const planAt = t => async id => ({ run: /saved:(\d+)/.exec(id)[1], attempt: Number(/@(\d+)/.exec(id)[1]), startedAt: t });

let stub, dbPath;
beforeEach(async () => {
  dbPath = fresh();
  resetHooks();
  C.configure({ planRun: planAt(C.clock.now() - 10) });
  stub = await stubControl({ states: {} });
});
afterEach(async () => { await stub.close(); C.close(); });

// ---------- R6-1 ----------

function world() {
  const w = { ds20Attempt: 1, ds20: { status: 'in_progress', conclusion: null }, fail: false };
  w.gh = fakeGh([
    [/trading-core\/actions\/runs\/10\/attempts\/1\/jobs/, { jobs: [{ id: 1, status: 'completed', conclusion: 'success', run_attempt: 1,
      steps: [{ name: 'Build and push image', conclusion: 'success' }, { name: 'Trigger environment deployment workflow', conclusion: 'success' }] }] }],
    [/actions\/jobs\/1\/logs/, 'dispatched https://github.com/Equicom-Crypto/crpko-devops/actions/runs/20'],
    [/trading-core\/actions\/runs\/10$/, { id: 10, path: '.github/workflows/release.yml', event: 'push', status: 'completed', conclusion: 'success',
      head_sha: SHA1, head_branch: tagFor(), run_attempt: 1, updated_at: '2026-01-01T00:00:00Z' }],
    [/crpko-devops\/actions\/runs\/20\/attempts\/1\/jobs/, { total_count: 1, jobs: [{ id: 200, status: 'completed', conclusion: 'success', run_attempt: 1,
      steps: [{ name: 'Validate release tag', conclusion: 'success' }] }] }],
    [/actions\/jobs\/200\/logs/, deployLog('trading-core', tagFor(), SHA1)],
    [/crpko-devops\/actions\/runs\/20$/, () => { if (w.fail) throw new Error('HTTP 503 fetching downstream run');
      return { id: 20, path: '.github/workflows/deploy-dev-service.yml', run_attempt: w.ds20Attempt, ...w.ds20 }; }],
  ]);
  return w;
}

test('R6-1 an observation error is applied with the version check, so an older terminal result is dropped', async () => {
  const w = world();
  const observe = rr => E.observeRelease({ ...rr, updated_at: 0 }, { gh: w.gh });
  const r = await start(await admit(svc('a')), { releaseRun: '10' });
  await C.releaseObserve(r.id, { observe });
  w.ds20 = { status: 'completed', conclusion: 'success' };
  const gate = {};
  gate.wait = new Promise(res => { gate.release = res; });
  let readDone;
  const aRead = new Promise(res => { readDone = res; });
  const a = C.releaseObserve(r.id, { observe: async rr => { const res = await observe(rr); readDone(res.state); await gate.wait; return res; } });
  assert.equal(await aRead, 'done');
  w.fail = true; // a newer pump observation cannot read the downstream run
  const v0 = C.releaseList({ state: 'running' }).releases[0].version;
  const p = await P.pump({ cfg: stub.cfg, observe });
  assert.match(p.observed[0].pending, /observation failed/);
  assert.equal(C.releaseList({ state: 'running' }).releases[0].version, v0 + 1);
  gate.release();
  assert.equal((await a).release.state, 'running');
  throwsCode(() => C.qaOpen({ as: 'harness', env: 'dev' }), 'env_busy');
});

test('R6-1 a late observation error does not touch a release closed by hand meanwhile', async () => {
  const r = await start(await admit(svc('b')), { releaseRun: '10' });
  let fail;
  const failing = new Promise((_, rej) => { fail = rej; });
  const late = C.releaseObserve(r.id, { observe: () => failing });
  const closed = (await C.releaseReconcile(r.id, { as: 'release', outcome: 'not_started', evidence: 'no tag pushed' })).release;
  fail(new Error('HTTP 502'));
  const res = await late;
  assert.match(res.pending, /changed while observing/);
  const row = C.releaseList({ state: 'cancelled' }).releases[0];
  assert.deepEqual([row.version, row.observe_note], [closed.version, closed.observe_note]);
});

// ---------- R6-2 / env rule ----------

test('R6-2 mutation claims need one concrete supported environment', () => {
  for (const env of ['', '   ']) throwsCode(() => C.claim('svc:trading-core', { as: 'cell:d', env }), 'env_required');
  throwsCode(() => C.claim('svc:trading-core', { as: 'cell:d' }), 'env_required');
  throwsCode(() => C.claim('svc:trading-core', { as: 'cell:d', env: '*' }), 'env_unsupported');
  throwsCode(() => C.claim('svc:trading-core', { as: 'cell:d', env: 'staging' }), 'env_unsupported');
  throwsCode(() => C.claim('env:*', { as: 'cell:d' }), 'env_unsupported');
  throwsCode(() => C.claim('env:', { as: 'cell:d' }), 'env_required');
  throwsCode(() => C.claim('tf:staging', { as: 'cell:d' }), 'env_unsupported');
  throwsCode(() => C.claim('tf:dev', { as: 'cell:d', env: '' }), 'env_required');
  assert.equal(C.claim('pr:x#1', { as: 'cell:d', env: '' }).env, null, 'coordination claims ignore env');
  assert.equal(C.claim('svc:trading-core', { as: 'cell:d', env: 'dev' }).env, 'dev');
});

test('R6-2 the CLI refuses an empty --env', () => {
  C.close();
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'claim', 'svc:trading-core', '--as', 'cell:direct', '--env', ''],
    { env: { ...process.env, COORD_DB: dbPath }, encoding: 'utf8' });
  assert.deepEqual([r.status, JSON.parse(r.stdout).error.code], [1, 'env_required']);
  C.open(dbPath);
});

// ---------- R6-3 ----------

test('R6-3 env:* is refused, and an env:dev umbrella and an ordinary dev release exclude each other, both orders and expired', async () => {
  // The wildcard umbrella the review reproduced (it was not held by ordinary releases) no longer exists.
  throwsCode(() => C.claim('env:*', { as: 'cell:global', op: 'environment mutation' }), 'env_unsupported');
  const c = C.claim('env:dev', { as: 'cell:global', op: 'environment mutation' });
  await refused(() => admit(svc('u1')), 'claimed');
  C.release('env:dev', { as: 'cell:global', fence: c.fence });
  const a = await start(await admit(svc('u2')));
  throwsCode(() => C.claim('env:dev', { as: 'cell:global' }), 'release_in_flight');
  await C.releaseReconcile(a.id, { as: 'release', outcome: 'done', evidence: 'deploy run 20 attempt 1 ok' });
  C.claim('env:dev', { as: 'cell:global', ttl: '1s' });
  advance(2);
  await refused(() => admit(svc('u3', { n: 34 })), 'reconcile_required');
});

test('guard for R6-3: an umbrella captured at admission keeps working for its owner; a foreign one taken after admission is refused', async () => {
  const c = C.claim('env:dev', { as: 'crw', op: 'deploy' });
  const a = await admit(svc('u4'));
  assert.deepEqual(a.claim_fences, { 'env:dev': { owner: 'crw', fence: c.fence } });
  assert.equal(C.check('env:dev', { as: 'crw', fence: c.fence }).fence, c.fence);
  assert.equal((await start(a)).state, 'running');
  C.release('env:dev', { as: 'crw', fence: c.fence });
  throwsCode(() => C.claim('env:dev', { as: 'cell:global' }), 'release_in_flight');
});

// ---------- R6-4 ----------

test('R6-4 claim reconcile is bound to its fence: a retried old reconcile never closes the new claim', () => {
  C.claim('tf:dev', { as: 'old', ttl: '1s', op: 'apply-1' });
  advance(2);
  const first = C.reconcile('tf:dev', { as: 'release', fence: 1, outcome: 'done', evidence: 'apply-1 completed' });
  assert.equal(first.state, 'reconciled');
  C.claim('tf:dev', { as: 'new', ttl: '1s', op: 'apply-2' });
  advance(2);
  const retry = C.reconcile('tf:dev', { as: 'release', fence: 1, outcome: 'done', evidence: 'apply-1 completed' });
  assert.deepEqual([retry.historical, retry.fence, retry.outcome], [true, 1, 'done']);
  assert.equal(C.claims({}).claims.find(x => x.resource === 'tf:dev').state, 'reconcile_required');
  throwsCode(() => C.claim('tf:dev', { as: 'third' }), 'reconcile_required');
  throwsCode(() => C.reconcile('tf:dev', { as: 'release', fence: 7, outcome: 'done', evidence: 'x' }), 'stale_fence');
  throwsCode(() => C.reconcile('tf:dev', { as: 'release', outcome: 'done', evidence: 'x' }), 'invalid');
});

test('R6-4 the CLI forwards --fence to reconcile', () => {
  C.claim('tf:dev', { as: 'old', ttl: '1s' });
  advance(2);
  assert.throws(() => C.claim('tf:dev', { as: 'other' }), e => e.code === 'reconcile_required'); // persists the expiry (the CLI runs on the real clock)
  C.close();
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), ...args], { env: { ...process.env, COORD_DB: dbPath }, encoding: 'utf8' });
    return { status: r.status, out: JSON.parse(r.stdout) };
  };
  assert.equal(cli('reconcile', 'tf:dev', '--as', 'release', '--outcome', 'done', '--evidence', 'x').out.error.code, 'invalid');
  assert.equal(cli('reconcile', 'tf:dev', '--as', 'release', '--fence', '2', '--outcome', 'done', '--evidence', 'x').out.error.code, 'stale_fence');
  assert.equal(cli('reconcile', 'tf:dev', '--as', 'release', '--fence', '1', '--outcome', 'done', '--evidence', 'x').out.state, 'reconciled');
  C.open(dbPath);
});

// ---------- R6-5 ----------

test('R6-5 a claim-only Terraform mutation makes earlier saved plans stale (normal release)', async () => {
  C.setFlag('tf_full_root_blocked', false, { as: 'master' });
  const planned = C.clock.now() - 10;
  const c = C.claim('tf:dev', { as: 'cell:manual', op: 'terraform apply' });
  advance(20);
  C.release('tf:dev', { as: 'cell:manual', fence: c.fence, note: 'apply done' });
  assert.ok(C.tfRootGen('dev').gen >= 1);
  await refused(() => admit(tf('p'), { planRun: planAt(planned) }), 'stale_plan');
});

test('R6-5 a claim-only Terraform mutation that expired and was reconciled makes earlier plans stale', async () => {
  C.setFlag('tf_full_root_blocked', false, { as: 'master' });
  const p = tf('r');
  const planned = C.clock.now() - 10;
  C.claim('tf:dev', { as: 'cell:manual', ttl: '1s', op: 'terraform apply' });
  advance(2);
  C.reconcile('tf:dev', { as: 'master', fence: 1, outcome: 'done', evidence: 'apply finished' });
  await refused(() => admit(p, { planRun: planAt(planned) }), 'stale_plan');
});

test('R6-5 claim-only mutations bump their roots at acquire and end; env:dev bumps every dev root', async () => {
  C.setFlag('tf_full_root_blocked', false, { as: 'master' });
  const planned = C.clock.now() - 10;
  C.claim('tf:dev', { as: 'cell:manual', ttl: '1s', op: 'apply' });
  const g1 = C.tfRootGen('dev').gen;
  assert.equal(g1, 1, 'acquire bumps');
  advance(5);
  C.reconcile('tf:dev', { as: 'master', fence: 1, outcome: 'done', evidence: 'apply finished' });
  assert.equal(C.tfRootGen('dev').gen, 2, 'reconcile of the expired claim bumps');
  await refused(() => admit(tf('q'), { planRun: planAt(planned) }), 'stale_plan');
  const e = C.claim('env:dev', { as: 'cell:env' });
  for (const root of ['dev', 'dev-risk-liquidation', 'dev-core-capacity']) assert.ok(C.tfRootGen(root).gen >= 1, root);
  const before = C.tfRootGen('dev-core-capacity').gen;
  C.release('env:dev', { as: 'cell:env', fence: e.fence });
  assert.equal(C.tfRootGen('dev-core-capacity').gen, before + 1, 'umbrella end bumps');
});

// ---------- R6-6 ----------

test('R6-6 a null or malformed plan verification is refused at admission', async () => {
  C.setFlag('tf_full_root_blocked', false, { as: 'master' });
  const t = C.clock.now() - 5;
  const bad = [null, undefined, false, {}, { startedAt: 0 }, { startedAt: -1 }, { startedAt: NaN }, { startedAt: Infinity }, { startedAt: String(t) },
    { startedAt: t, run: '901', attempt: 1 }, { startedAt: t, run: '900', attempt: 2 }];
  const r = tf('valid');
  for (const v of bad) await refused(() => admit(r, { planRun: async () => v }), 'plan_unverified');
  assert.equal((await admit(r, { planRun: planAt(t) })).state, 'admitted');
});

test('R6-6 a null plan verification at start is refused after a valid admission', async () => {
  C.setFlag('tf_full_root_blocked', false, { as: 'master' });
  const a = await admit(tf('s'), { planRun: planAt(C.clock.now() - 5) });
  await refused(() => start(a, { planRun: async () => null }), 'plan_unverified');
  await refused(() => start(a, { planRun: planAt(C.clock.now() - 6) }), 'plan_unverified');
  assert.equal(C.releaseList({ state: 'admitted' }).releases.length, 1);
});

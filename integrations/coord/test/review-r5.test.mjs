// Regression tests for review r5 of f82077c286, one or more per finding (R5-<N> in the test name).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as C from '../lib/coord.mjs';
import * as E from '../lib/evidence.mjs';
import { run } from '../lib/db.mjs';
import { fresh, advance, stubControl, SHA0, SHA1, fakeGh, deployLog, resetHooks, tagFor } from './helpers.mjs';

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
  C.configure({ planRun: async () => ({ startedAt: C.clock.now() - 10 }) });
  stub = await stubControl({ states: {} });
});
afterEach(async () => { await stub.close(); C.close(); });

// ---------- R5-1 ----------

test('R5-1 an older observation cannot finalize after a newer one recorded unknown', async () => {
  const w = { relAttempt: 1, ds20: { status: 'in_progress', conclusion: null } };
  const gh = fakeGh([
    [/trading-core\/actions\/runs\/10\/attempts\/(\d+)\/jobs/, m => ({ jobs: [{ id: 1, status: 'completed', conclusion: 'success', run_attempt: Number(m[1]),
      steps: [{ name: 'Build and push image', conclusion: 'success' }, { name: 'Trigger environment deployment workflow', conclusion: 'success' }] }] })],
    [/actions\/jobs\/1\/logs/, 'dispatched https://github.com/Equicom-Crypto/crpko-devops/actions/runs/20'],
    [/trading-core\/actions\/runs\/10$/, () => ({ id: 10, path: '.github/workflows/release.yml', event: 'push', status: 'completed', conclusion: 'success',
      head_sha: SHA1, head_branch: tagFor(), run_attempt: w.relAttempt, updated_at: '2026-01-01T00:00:00Z' })],
    [/crpko-devops\/actions\/runs\/20\/attempts\/1\/jobs/, { total_count: 1, jobs: [{ id: 200, status: 'completed', conclusion: 'success', run_attempt: 1,
      steps: [{ name: 'Validate release tag', conclusion: 'success' }] }] }],
    [/actions\/jobs\/200\/logs/, deployLog('trading-core', tagFor(), SHA1)],
    [/crpko-devops\/actions\/runs\/20$/, () => ({ id: 20, path: '.github/workflows/deploy-dev-service.yml', run_attempt: 1, ...w.ds20 })],
  ]);
  const obs = id => C.releaseObserve(id, { observe: rr => E.observeRelease({ ...rr, updated_at: 0 }, { gh }) });
  const r = await start(await admit(svc('a')), { releaseRun: '10' });
  const first = await obs(r.id);
  assert.deepEqual([first.release.state, first.release.release_attempt, first.release.deploy_run, first.release.deploy_attempt], ['running', 1, '20', 1]);
  w.ds20 = { status: 'completed', conclusion: 'success' };
  // Observer A reads complete, consistent evidence (done), then stalls before applying it.
  const gate = {};
  gate.wait = new Promise(res => { gate.release = res; });
  let readDone;
  const aRead = new Promise(res => { readDone = res; });
  const a = C.releaseObserve(r.id, { observe: async rr => {
    const res = await E.observeRelease({ ...rr, updated_at: 0 }, { gh });
    readDone(res.state);
    await gate.wait;
    return res;
  } });
  assert.equal(await aRead, 'done');
  // Observer B sees the parent rerun and records unknown.
  w.relAttempt = 2;
  const b = await obs(r.id);
  assert.equal(b.release.state, 'running');
  assert.match(b.pending, /attempt 1 to 2/);
  gate.release();
  const aDone = await a;
  assert.equal(aDone.release.state, 'running', 'the older terminal result is dropped');
  assert.equal(C.releaseList({ state: 'running' }).releases.length, 1);
  throwsCode(() => C.qaOpen({ as: 'harness', env: 'dev' }), 'env_busy');
});

test('R5-1 a pending observation with no new bindings still invalidates older ones', async () => {
  const r = await start(await admit(svc('b')), { releaseRun: '10', deployRun: '20' });
  const v0 = C.releaseList({ state: 'running' }).releases[0].version;
  await C.releaseObserve(r.id, { observe: async () => ({ state: 'unknown', why: 'unaccounted rerun' }) });
  assert.equal(C.releaseList({ state: 'running' }).releases[0].version, v0 + 1);
});

// ---------- R5-2 ----------

const ROOTS = ['tf:dev', 'tf:dev-risk-liquidation', 'tf:dev-core-capacity'];

test('R5-2 tf roots and env: claims keep their own environment; a contradictory env is refused', () => {
  for (const res of [...ROOTS, 'env:dev']) {
    throwsCode(() => C.claim(res, { as: 'cell:m', env: 'staging' }), 'env_mismatch');
    const c = C.claim(res, { as: 'cell:m', env: 'dev' });
    assert.equal(c.env, 'dev');
    C.release(res, { as: 'cell:m', fence: c.fence });
  }
  assert.equal(C.claimEnv('svc:trading-core', 'dev'), 'dev');
  assert.equal(C.claimEnv('svc:trading-core'), '*');
});

test('R5-2 each dev root versus a dev QA window, both orders', () => {
  for (const res of ROOTS) {
    const q = C.qaOpen({ as: 'harness', env: 'dev' }).release;
    throwsCode(() => C.claim(res, { as: 'cell:m', env: 'staging' }), 'env_mismatch');
    throwsCode(() => C.claim(res, { as: 'cell:m' }), 'qa_window_open');
    C.qaClose(q.id, { as: 'harness' });
    const c = C.claim(res, { as: 'cell:m' });
    throwsCode(() => C.qaOpen({ as: 'harness', env: 'dev' }), 'claimed');
    C.release(res, { as: 'cell:m', fence: c.fence });
    advance(1);
  }
});

test('R5-2 each dev root versus an env-exclusive non-Terraform release, both orders', async () => {
  const mig = (key, i) => C.releaseRequest({ as: 'release', key, kind: 'migration', env: 'dev', plan: `m${i}.sql@${'e'.repeat(64)}` }).release;
  let i = 0;
  for (const res of ROOTS) {
    const d = await start(await admit(mig(`d${i}`, i++)));
    throwsCode(() => C.claim(res, { as: 'cell:m', env: 'staging' }), 'env_mismatch');
    throwsCode(() => C.claim(res, { as: 'cell:m' }), 'release_in_flight');
    await C.releaseReconcile(d.id, { as: 'release', outcome: 'done', evidence: 'migration applied' });
    const c = C.claim(res, { as: 'cell:m' });
    await refused(() => admit(mig(`e${i}`, i++)), 'claimed');
    C.release(res, { as: 'cell:m', fence: c.fence });
  }
});

// ---------- R5-3 ----------

test('R5-3 an env: claim and a foreign narrower mutation claim in that env exclude each other, both orders', () => {
  const apply = C.claim('env:dev', { as: 'cell:apply', op: 'full-root apply' });
  for (const [res, env] of [['svc:trading-core', 'dev'], ['tf:dev', undefined], ['ch:ddl', undefined], ['repo:x', 'dev']])
    throwsCode(() => C.claim(res, { as: 'cell:deploy', env }), 'claimed');
  C.claim('pr:x#1', { as: 'cell:deploy' }); // coordination claims are unaffected
  C.claim('svc:edge-api', { as: 'cell:other', env: 'staging' }); // other environments are unaffected
  C.release('env:dev', { as: 'cell:apply', fence: apply.fence });
  const deploy = C.claim('svc:trading-core', { as: 'cell:deploy', env: 'dev' });
  throwsCode(() => C.claim('env:dev', { as: 'cell:apply' }), 'claimed');
  C.claim('svc:ws-gateway', { as: 'cell:third', env: 'dev' }); // disjoint narrow claims stay independent
  // A raced row does not pass check either.
  run("INSERT OR REPLACE INTO claims (resource,owner,fence,state,lease_until,env) VALUES ('env:dev','cell:apply',9,'active',?,'dev')", C.clock.now() + 600);
  throwsCode(() => C.check('svc:trading-core', { as: 'cell:deploy', fence: deploy.fence }), 'claimed');
  throwsCode(() => C.check('env:dev', { as: 'cell:apply', fence: 9 }), 'claimed');
});

test('R5-3 a wildcard mutation claim overlaps env:<e>, and the same owner gets no exception', () => {
  const w = C.claim('svc:trading-core', { as: 'cell:a' });
  assert.equal(w.env, '*');
  throwsCode(() => C.claim('env:dev', { as: 'cell:a' }), 'claimed');
  C.release('svc:trading-core', { as: 'cell:a', fence: w.fence });
  C.claim('env:dev', { as: 'cell:a' });
  throwsCode(() => C.claim('svc:trading-core', { as: 'cell:a' }), 'claimed');
});

test('R5-3 an expired env: claim blocks narrower claims until reconciled', () => {
  C.claim('env:dev', { as: 'cell:apply', ttl: '1s', op: 'apply' });
  advance(2);
  throwsCode(() => C.claim('svc:trading-core', { as: 'cell:deploy', env: 'dev' }), 'reconcile_required');
  C.reconcile('env:dev', { as: 'master', outcome: 'done', evidence: 'apply finished' });
  assert.equal(C.claim('svc:trading-core', { as: 'cell:deploy', env: 'dev' }).env, 'dev');
});

// ---------- R5-4 ----------

test('R5-4 a wildcard mutation claim passes every environment gate', () => {
  for (const mode of ['pause', 'drain']) {
    C.setMode(mode, { scope: 'env:dev', as: 'master', reason: 'r' });
    throwsCode(() => C.claim('svc:trading-core', { as: 'cell:direct', env: 'dev' }), mode === 'pause' ? 'paused' : 'draining');
    throwsCode(() => C.claim('svc:trading-core', { as: 'cell:direct' }), mode === 'pause' ? 'paused' : 'draining');
    assert.equal(C.claim('svc:edge-api', { as: 'cell:direct', env: 'staging' }).env, 'staging');
    C.claim('pr:z#1', { as: 'cell:direct' }); // coordination claims follow the global gate only
    run('DELETE FROM claims');
    C.setMode('run', { scope: 'env:dev', as: 'master' });
  }
});

test('R5-4 the CLI forwards --env to claim', () => {
  C.setMode('pause', { scope: 'env:dev', as: 'master', reason: 'r' });
  C.close();
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), ...args], { env: { ...process.env, COORD_DB: dbPath }, encoding: 'utf8' });
    return { status: r.status, out: JSON.parse(r.stdout || 'null') };
  };
  for (const extra of [['--env', 'dev'], []]) {
    const r = cli('claim', 'svc:trading-core', '--as', 'cell:direct', ...extra, '--op', 'direct deploy');
    assert.deepEqual([r.status, r.out.error?.code], [1, 'paused'], extra.join(' '));
  }
  const s = cli('claim', 'svc:edge-api', '--as', 'cell:direct', '--env', 'staging');
  assert.deepEqual([s.status, s.out.env], [0, 'staging']);
  C.open(dbPath);
});

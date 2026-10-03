// Regression tests for review r4 of 35ae2cfd0c, one or more per finding (R4-<N> in the test name).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../lib/coord.mjs';
import * as E from '../lib/evidence.mjs';
import { fresh, stubControl, SHA0, SHA1, fakeGh, deployLog, resetHooks, tagFor } from './helpers.mjs';

const TC = 'equicom-crypto/trading-core';
const ok = async () => ({ ok: true });
const refused = (fn, code) => assert.rejects(async () => fn(), e => { assert.equal(e.code, code, `${e.code}: ${e.message}`); return true; });
const throwsCode = (fn, code) => assert.throws(fn, e => { assert.equal(e.code, code, `${e.code}: ${e.message}`); return true; });
const svc = (key, o = {}) => C.releaseRequest({ as: 'crw', key, kind: 'service_release', env: 'dev', repo: TC, binary: 'trading-core',
  sha: SHA1, runtimeSha: SHA0, contentPrs: [`${TC}#141`], ...o, n: undefined, tag: o.tag ?? tagFor(o.binary, o.n ?? 33) }).release;
const admit = async (r, o = {}) => (await C.releaseAdmit(r.id, { as: 'release', manual: true, verify: ok, ...o })).release;
const start = async (r, o = {}) => (await C.releaseStart(r.id, { as: 'release', fence: r.fence, verify: ok, ...o })).release;
const planOk = async () => ({ startedAt: C.clock.now() - 10 });

let stub;
beforeEach(async () => {
  fresh();
  resetHooks();
  C.configure({ planRun: planOk });
  stub = await stubControl({ states: {} });
});
afterEach(async () => { await stub.close(); C.close(); });

// ---------- R4-1 ----------

const PUSH = 'Build and push image';
const DISPATCH = 'Trigger environment deployment workflow';
// Fake GitHub where the trading-core release run 10 and the crpko-devops deploy runs can change between calls.
function world() {
  const w = {
    rel: { attempt: 1, conclusion: 'success', steps: { [PUSH]: 'success', [DISPATCH]: 'success' }, links: ['20'] },
    ds: { 20: { status: 'in_progress', attempt: 1, conclusion: null }, 21: { status: 'in_progress', attempt: 1, conclusion: null } },
  };
  w.gh = fakeGh([
    [/trading-core\/actions\/runs\/10\/attempts\/(\d+)\/jobs/, m => ({ jobs: [{ id: 1, status: 'completed', conclusion: w.rel.conclusion, run_attempt: Number(m[1]),
      steps: Object.entries(w.rel.steps).map(([name, conclusion]) => ({ name, conclusion })) }] })],
    [/actions\/jobs\/1\/logs/, () => w.rel.links.map(l => `dispatched https://github.com/Equicom-Crypto/crpko-devops/actions/runs/${l}`).join('\n')],
    [/trading-core\/actions\/runs\/10$/, () => ({ id: 10, path: '.github/workflows/release.yml', event: 'push', status: 'completed', conclusion: w.rel.conclusion,
      head_sha: SHA1, head_branch: tagFor(), run_attempt: w.rel.attempt, updated_at: '2026-01-01T00:00:00Z' })],
    [/crpko-devops\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs/, m => ({ total_count: 1, jobs: [{ id: Number(m[1]) * 10, status: 'completed', conclusion: 'success',
      run_attempt: Number(m[2]), steps: [{ name: 'Validate release tag', conclusion: 'success' }] }] })],
    [/actions\/jobs\/(\d+)0\/logs/, () => deployLog('trading-core', tagFor(), SHA1)],
    [/crpko-devops\/actions\/runs\/(\d+)$/, m => ({ id: Number(m[1]), path: '.github/workflows/deploy-dev-service.yml', status: w.ds[m[1]].status,
      conclusion: w.ds[m[1]].conclusion, run_attempt: w.ds[m[1]].attempt })],
  ]);
  return w;
}
const observe = (r, w) => C.releaseObserve(r.id, { observe: rr => E.observeRelease({ ...rr, updated_at: 0 }, { gh: w.gh }) });

test('R4-1 a parent rerun after a dispatch keeps the release unknown with its locks, across observations', async () => {
  const w = world();
  const r = await start(await admit(svc('a')), { releaseRun: '10' });
  w.rel.conclusion = 'failure';
  const first = await observe(r, w);
  assert.deepEqual([first.release.state, first.release.deploy_run, first.release.release_attempt], ['running', '20', 1]);
  // Attempt 2 fails during setup: nothing published, nothing dispatched, no link. Run 20 still runs.
  Object.assign(w.rel, { attempt: 2, steps: { [PUSH]: 'skipped', [DISPATCH]: 'skipped' }, links: [] });
  const second = await observe(r, w);
  assert.equal(second.release.state, 'running');
  assert.match(second.pending, /attempt 1 to 2/);
  throwsCode(() => C.qaOpen({ as: 'harness', env: 'dev' }), 'env_busy');
  w.ds[20] = { status: 'completed', attempt: 1, conclusion: 'success' };
  assert.equal((await observe(r, w)).release.state, 'running', 'needs a manual reconcile');
});

test('R4-1 a newer parent attempt that dispatched another run cannot complete on the bound old run', async () => {
  const w = world();
  const r = await start(await admit(svc('b')), { releaseRun: '10', deployRun: '20' });
  w.ds[20] = { status: 'completed', attempt: 1, conclusion: 'success' };
  Object.assign(w.rel, { attempt: 2, links: ['21'] });
  const o = await observe(r, w);
  assert.equal(o.release.state, 'running');
  // The first observation of a parent already past attempt 1 is unknown too.
  const w2 = world();
  w2.rel.attempt = 2;
  const r2 = await start(await admit(svc('c', { repo: 'Equicom-Crypto/edge-api', binary: 'edge-api' })), { releaseRun: '10' });
  assert.match((await E.observeRelease({ ...r2, repo: TC, binary: 'trading-core', tag: tagFor(), updated_at: 0 }, { gh: w2.gh })).reason, /first observed at attempt 2/);
});

test('R4-1 a log link that is not the bound downstream run is unknown', async () => {
  const w = world();
  const r = await start(await admit(svc('d')), { releaseRun: '10', deployRun: '20' });
  w.ds[20] = { status: 'completed', attempt: 1, conclusion: 'success' };
  w.rel.links = ['21'];
  assert.equal((await observe(r, w)).release.state, 'running');
  w.rel.links = ['20'];
  assert.equal((await observe(r, w)).release.state, 'done', 'the bound run alone decides');
});

// ---------- R4-2 ----------

test('R4-2 an open QA window excludes every mutation claim in its environment, both orders', () => {
  const q = C.qaOpen({ as: 'harness', env: 'dev' }).release;
  for (const res of ['tf:dev', 'svc:trading-core', 'repo:equicom-crypto/edge-api', 'ch:ddl'])
    throwsCode(() => C.claim(res, { as: 'cell:manual', op: 'mutate', env: 'dev' }), 'qa_window_open');
  C.claim('pr:x#1', { as: 'cell:manual' }); // coordination claims stay free
  C.qaClose(q.id, { as: 'harness' });
  const c = C.claim('tf:dev', { as: 'cell:manual', op: 'terraform apply' });
  assert.equal(c.env, 'dev');
  throwsCode(() => C.qaOpen({ as: 'harness', env: 'dev' }), 'claimed');
  C.release('tf:dev', { as: 'cell:manual', fence: c.fence });
  C.claim('svc:trading-core', { as: 'cell:manual', env: 'dev' });
  throwsCode(() => C.qaOpen({ as: 'harness', env: 'dev' }), 'claimed');
});

test('R4-2 an env-exclusive release excludes every mutation claim in its environment, both orders', async () => {
  C.setFlag('tf_full_root_blocked', false, { as: 'master' });
  const tf = key => C.releaseRequest({ as: 'release', key, kind: 'tf_apply', env: 'dev', plan: `saved:${key.length + 900}@1`, footprint: ['env:dev'] }).release;
  // Release first: a direct deploy's service claim, and a ch: claim, are refused while it is in flight.
  const s = await start(await admit(tf('p')));
  throwsCode(() => C.claim('svc:trading-core', { as: 'cell:direct', op: 'deploy', env: 'dev' }), 'release_in_flight');
  throwsCode(() => C.claim('ch:ddl', { as: 'cell:direct', env: 'dev' }), 'release_in_flight');
  C.claim('pr:y#1', { as: 'cell:direct' }); // coordination claims stay free
  await C.releaseReconcile(s.id, { as: 'release', outcome: 'done', evidence: 'run 1 plan attempt 1 ok', currentAttempt: async () => 1 });
  // Claim first: an env-exclusive release cannot be admitted over a foreign service claim in its environment.
  const later = async () => ({ startedAt: C.clock.now() + 1 });
  const c = C.claim('svc:trading-core', { as: 'cell:direct', op: 'deploy', env: 'dev' });
  await refused(() => admit(tf('pp'), { planRun: later }), 'claimed');
  C.release('svc:trading-core', { as: 'cell:direct', fence: c.fence });
  assert.equal((await admit(tf('pp'), { planRun: later })).state, 'admitted');
});

// ---------- R4-3 ----------

test('R4-3 a failed push step is not proof that no image exists', async () => {
  const w = world();
  // Registry-style: push succeeded, a later check in the same step failed; dispatch skipped.
  Object.assign(w.rel, { conclusion: 'failure', steps: { [PUSH]: 'failure', [DISPATCH]: 'skipped' }, links: [] });
  const r = await start(await admit(svc('e')), { releaseRun: '10' });
  const o = await observe(r, w);
  assert.equal(o.release.state, 'running');
  assert.match(o.pending, /may exist/);
  await refused(() => admit(svc('next', { n: 34, sha: 'd'.repeat(40), repo: TC })), 'footprint_busy');
  // Only a push step that provably never ran makes it a plain failure.
  w.rel.steps = { [PUSH]: 'skipped', [DISPATCH]: 'skipped' };
  assert.equal((await observe(r, w)).release.state, 'failed');
  assert.equal(E.classify({ release: { status: 'completed', conclusion: 'failure' }, published: 'unknown', dispatched: 'no' }).state, 'unknown');
});

// ---------- R4-4 ----------

test('R4-4 a plan rerun that starts while the plan attempt is verified is refused', async () => {
  const SAVED = ['Package saved full-root plan', 'Configure AWS credentials for saved plan storage', 'Store saved plan in the state bucket', 'Upload saved plan metadata'];
  let latest = 1;
  const gh = fakeGh([
    [/crpko-devops\/actions\/runs\/900$/, () => ({ id: 900, run_attempt: latest, status: latest === 1 ? 'completed' : 'in_progress' })],
    [/runs\/900\/attempts\/1$/, { path: '.github/workflows/terraform-dev.yml', status: 'completed', conclusion: 'success', head_branch: 'main-dev', run_started_at: '2026-01-01T00:00:00Z' }],
    [/runs\/900\/attempts\/1\/jobs/, () => { latest = 2; return { jobs: [{ id: 9, status: 'completed', conclusion: 'success', run_attempt: 1, steps: SAVED.map(name => ({ name, conclusion: 'success' })) }] }; }],
  ]);
  await refused(() => E.planRun('saved:900@1', { gh }), 'plan_attempt_moved');
  C.setFlag('tf_full_root_blocked', false, { as: 'master' });
  const p = await admit(C.releaseRequest({ as: 'release', key: 'p', kind: 'tf_apply', env: 'dev', plan: 'saved:900@1', footprint: ['env:dev'] }).release);
  latest = 1;
  await refused(() => start(p, { planRun: id => E.planRun(id, { gh }) }), 'plan_attempt_moved');
  assert.equal(C.releaseList({ state: 'admitted' }).releases.length, 1);
});

// ---------- R4-5 ----------

test('R4-5 tags only accept release binaries from the release-tag schema; repository names are refused', () => {
  for (const [repo, binary] of [['custody-transfer', 'custody-transfer'], ['risk-liquidation-latest', 'risk-liquidation-latest'],
    ['market-data-mock', 'market-data-mock'], ['venue-router-adapters-mock', 'venue-router-adapters-mock']])
    throwsCode(() => svc(`t-${binary}`, { repo: `Equicom-Crypto/${repo}`, binary, tag: `${binary}-docs85-dev.21` }), 'invalid_tag');
  assert.equal(C.parseTag('custody-transfer-docs85-dev.21'), null);
  assert.deepEqual(C.parseTag('custody-transfers-docs85-dev.21'), { binary: 'custody-transfers', docs: 85, env: 'dev', version: 21 });
  assert.equal(svc('ok', { repo: 'Equicom-Crypto/custody-transfer', binary: 'custody-transfers', tag: 'custody-transfers-docs85-dev.21' }).binary, 'custody-transfers');
  assert.equal(C.RELEASE_BINARIES.includes('custody-transfers'), true);
});

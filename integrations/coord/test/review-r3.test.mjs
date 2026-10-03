// Regression tests for review r3 of bccc605b0b, one per finding (F<N> in the test name).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../lib/coord.mjs';
import * as E from '../lib/evidence.mjs';
import { run } from '../lib/db.mjs';
import { fresh, stubControl, SHA0, SHA1, SHA2, DIGEST, fakeGh, deployLog, resetHooks, tagFor } from './helpers.mjs';

const TC = 'equicom-crypto/trading-core';
const DEVOPS = 'equicom-crypto/crpko-devops';
const ok = async () => ({ ok: true });
const refused = (fn, code) => assert.rejects(async () => fn(), e => { assert.equal(e.code, code, `${e.code}: ${e.message}`); return true; });
const throwsCode = (fn, code) => assert.throws(fn, e => { assert.equal(e.code, code, `${e.code}: ${e.message}`); return true; });
// `footprint` and `rangeEvidence` only matter to the previous contract; they let old-head runs reach the behaviour under test.
const svc = (key, o = {}) => C.releaseRequest({ as: 'crw', key, kind: 'service_release', env: 'dev', repo: TC, binary: 'trading-core',
  sha: SHA1, runtimeSha: SHA0, contentPrs: [`${TC}#141`], footprint: [`svc:${o.binary ?? 'trading-core'}`], rangeEvidence: 'x',
  ...o, n: undefined, tag: o.tag ?? tagFor(o.binary, o.n ?? 33) }).release;
const admit = async (r, o = {}) => (await C.releaseAdmit(r.id, { as: 'release', manual: true, verify: ok, ...o })).release;
const start = async (r, o = {}) => (await C.releaseStart(r.id, { as: 'release', fence: r.fence, verify: ok, ...o })).release;
const planOk = async () => ({ startedAt: C.clock.now() - 10 });
const tf = (key, o = {}) => C.releaseRequest({ as: 'release', key, kind: 'tf_apply', env: 'dev', plan: 'saved:900@1', footprint: ['env:dev'], ...o }).release;

let stub;
beforeEach(async () => {
  fresh();
  resetHooks();
  C.configure?.({ planRun: planOk });
  stub = await stubControl({ states: {} });
});
afterEach(async () => { await stub.close(); C.close(); });

test('F1 claims and releases exclude each other in both directions', async () => {
  const a = await start(await admit(svc('a')));
  throwsCode(() => C.claim('env:dev', { as: 'cell:manual', op: 'terraform apply' }), 'release_in_flight');
  throwsCode(() => C.claim('svc:trading-core', { as: 'cell:manual' }), 'release_in_flight');
  throwsCode(() => C.claim(`repo:${TC}`, { as: 'release' }), 'release_in_flight');
  C.claim('pr:x#1', { as: 'cell:manual' }); // unrelated resources stay claimable
  // A fence that races in (here written directly) does not pass check while the release holds the env.
  run("INSERT INTO claims (resource,owner,fence,state,lease_until) VALUES ('env:dev','cell:manual',7,'active',?)", C.clock.now() + 600);
  throwsCode(() => C.check('env:dev', { as: 'cell:manual', fence: 7 }), 'release_in_flight');
  // The fence the release relied on at admission remains usable by its owner.
  run("DELETE FROM claims WHERE resource='env:dev'");
  await C.releaseReconcile(a.id, { as: 'release', outcome: 'done', evidence: 'run 1 attempt 1 ok' });
  const c = C.claim('env:dev', { as: 'crw', op: 'deploy x' });
  const b = await admit(svc('b', { repo: 'Equicom-Crypto/x', binary: 'x', contentPrs: [`${TC}#141`] }));
  assert.deepEqual(b.claim_fences, { 'env:dev': { owner: 'crw', fence: c.fence } });
  assert.equal(C.check('env:dev', { as: 'crw', fence: c.fence }).fence, c.fence);
  C.renew('env:dev', { as: 'crw', fence: c.fence });
  // Terraform roots of a running service release are held too.
  const reg = await start(await admit(svc('reg', { repo: 'Equicom-Crypto/registry', binary: 'registry', contentPrs: [`${TC}#141`] })));
  throwsCode(() => C.claim('tf:dev', { as: 'cell:manual' }), 'release_in_flight');
  assert.ok(reg);
});

test('F2 service, redispatch and built tags must parse and name the request binary and dev', async () => {
  for (const tag of ['trading-core-docs87-prod.1', 'trading-core-docs87-staging.4', 'edge-api-docs87-dev.45', 'dev.33', 'trading-core-docs0-dev.1', 'trading-core-docs1-dev.01'])
    throwsCode(() => svc(`t-${tag}`, { tag }), 'invalid_tag');
  throwsCode(() => C.releaseRequest({ as: 'release', key: 'rd', kind: 'redispatch', env: 'dev', repo: TC, binary: 'trading-core', sha: SHA1, runtimeSha: SHA0,
    contentPrs: [`${TC}#141`], tag: 'trading-core-docs87-prod.1', digest: DIGEST }), 'invalid_tag');
  assert.deepEqual(C.parseTag('custody-transfers-docs85-dev.21'), { binary: 'custody-transfers', docs: 85, env: 'dev', version: 21 });
  // Rows from before tag validation are refused at admission and at start.
  const legacy = svc('legacy');
  run("UPDATE releases SET tag='trading-core-docs87-prod.1' WHERE id=?", legacy.id);
  await refused(() => admit(legacy), 'invalid_tag');
  run("UPDATE releases SET tag=? WHERE id=?", tagFor(), legacy.id);
  const a = await admit(legacy);
  run("UPDATE releases SET tag='trading-core-docs87-staging.2' WHERE id=?", a.id);
  await refused(() => start(a), 'invalid_tag');
  // Binding a tag on a built row.
  run("UPDATE releases SET state='built_not_deployed', tag=NULL WHERE id=?", a.id);
  throwsCode(() => C.releaseRecord(a.id, { as: 'release', evidence: 'ecr', tag: 'trading-core-docs87-prod.1' }), 'invalid_tag');
  assert.equal(C.releaseRecord(a.id, { as: 'release', evidence: 'ecr', tag: tagFor() }).release.tag, tagFor());
});

const releaseRun = o => ({ id: 10, path: '.github/workflows/release.yml', status: 'completed', conclusion: 'success', event: 'push',
  head_sha: SHA1, head_branch: tagFor(), run_attempt: 1, updated_at: '2026-01-01T00:00:00Z', ...o });
const downstreamRun = o => ({ id: 20, path: '.github/workflows/deploy-dev-service.yml', status: 'completed', conclusion: 'success', run_attempt: 1, ...o });
const obsGh = ({ rel = {}, ds = null, relSteps, link = true, dsLater } = {}) => {
  let dsReads = 0;
  return fakeGh([
    [/repos\/equicom-crypto\/trading-core\/actions\/runs\/10\/attempts\/\d+\/jobs/, { jobs: [{ id: 1, status: 'completed', conclusion: rel.conclusion ?? 'success', run_attempt: 1,
      steps: relSteps ?? [{ name: 'Build and push image', conclusion: 'success' }, { name: 'Trigger environment deployment workflow', conclusion: 'success' }] }] }],
    [/actions\/jobs\/1\/logs/, link ? 'dispatched https://github.com/Equicom-Crypto/crpko-devops/actions/runs/20' : 'no link'],
    [/repos\/equicom-crypto\/trading-core\/actions\/runs\/10$/, releaseRun(rel)],
    [/crpko-devops\/actions\/runs\/20\/attempts\/(\d+)\/jobs/, m => ({ total_count: 1, jobs: [{ id: 2, status: 'completed', conclusion: 'success', run_attempt: Number(m[1]),
      steps: [{ name: 'Validate release tag', conclusion: 'success' }] }] })],
    [/actions\/jobs\/2\/logs/, deployLog('trading-core', tagFor(), SHA1)],
    [/crpko-devops\/actions\/runs\/20$/, () => (++dsReads > 1 && dsLater ? downstreamRun(dsLater) : downstreamRun(ds ?? {}))],
  ]);
};
const runningRel = async o => ({ ...(await start(await admit(svc('o')), { releaseRun: '10', ...o })), updated_at: 0 });

test('F3 a parent failure never frees the locks while the downstream runs or dispatch is unknown', async () => {
  const r = await runningRel({ deployRun: '20' });
  const failedParent = { conclusion: 'failure' };
  const o = await C.releaseObserve(r.id, { observe: rr => E.observeRelease(rr, { gh: obsGh({ rel: failedParent, ds: { status: 'in_progress' } }) }) });
  assert.equal(o.release.state, 'running');
  throwsCode(() => C.qaOpen({ as: 'harness', env: 'dev' }), 'env_busy');
  const row = { ...r, deploy_run: null };
  // Failed parent, dispatch step ran but its link is not in the logs: unknown, never failed.
  const u = await E.observeRelease(row, { gh: obsGh({ rel: failedParent, link: false }) });
  assert.equal(u.state, 'unknown');
  // Failed parent whose log has the link: the downstream decides.
  assert.equal((await E.observeRelease(row, { gh: obsGh({ rel: failedParent, ds: { status: 'in_progress' } }) })).state, 'running');
  assert.equal((await E.observeRelease(row, { gh: obsGh({ rel: failedParent }) })).state, 'done');
  // Failed parent that provably never reached publication or dispatch: failed.
  const none = obsGh({ rel: failedParent, link: false, relSteps: [{ name: 'Build and push image', conclusion: 'failure' }, { name: 'Trigger environment deployment workflow', conclusion: 'skipped' }] });
  assert.equal((await E.observeRelease(row, { gh: none })).state, 'failed');
});

test('F4 risk-liquidation releases lock and advance the source dev root of the state handoff', async () => {
  const risk = svc('risk', { repo: 'Equicom-Crypto/risk-liquidation-latest', binary: 'risk-liquidation', contentPrs: [`${TC}#141`] });
  assert.ok(['tf:dev', 'tf:dev-risk-liquidation', 'tf:dev-core-capacity'].every(f => risk.footprint.includes(f)));
  const a = await admit(risk);
  await refused(() => admit(svc('reg', { repo: 'Equicom-Crypto/registry', binary: 'registry', contentPrs: [`${TC}#141`] })), 'footprint_busy');
  await start(a);
  assert.equal(C.tfRootGen('dev').gen, 1, 'source state handoff moves terraform/roots/dev');
});

// terraform-dev.yml (main-dev 34264683c2) lines 1466-1519.
const SAVED = ['Package saved full-root plan', 'Configure AWS credentials for saved plan storage', 'Store saved plan in the state bucket', 'Upload saved plan metadata'];
const planGh = ({ latest = 1, steps = SAVED.map(name => ({ name, conclusion: 'success' })) } = {}) => fakeGh([
  [/crpko-devops\/actions\/runs\/900$/, { id: 900, run_attempt: latest }],
  [/crpko-devops\/actions\/runs\/900\/attempts\/1$/, { path: '.github/workflows/terraform-dev.yml', status: 'completed', conclusion: 'success', head_branch: 'main-dev', run_started_at: '2026-01-01T00:00:00Z' }],
  [/crpko-devops\/actions\/runs\/900\/attempts\/1\/jobs/, { jobs: [{ id: 9, status: 'completed', conclusion: 'success', run_attempt: 1, steps }] }],
]);

test('F5 the pinned plan attempt must be the latest and must have saved a full-root plan, at admit, start and close', async () => {
  await refused(() => E.planRun('saved:900@1', { gh: planGh({ latest: 2 }) }), 'plan_attempt_moved');
  await refused(() => E.planRun('saved:900@1', { gh: planGh({ steps: [{ name: 'Terraform plan', conclusion: 'success' }] }) }), 'plan_unverified');
  await refused(() => E.planRun('saved:900@1', { gh: planGh({ steps: SAVED.map((name, i) => ({ name, conclusion: i === 3 ? 'skipped' : 'success' })) }) }), 'plan_unverified');
  assert.deepEqual(E.SAVED_PLAN_STEPS, SAVED);
  assert.equal((await E.planRun('saved:900@1', { gh: planGh() })).attempt, 1);
  C.setFlag('tf_full_root_blocked', false, { as: 'master' });
  const p = await admit(tf('p'), { planRun: rid => E.planRun(rid, { gh: planGh() }) });
  await refused(() => start(p, { planRun: rid => E.planRun(rid, { gh: planGh({ latest: 2 }) }) }), 'plan_attempt_moved');
  const s = await start(p, { planRun: rid => E.planRun(rid, { gh: planGh() }) });
  await refused(() => C.releaseReconcile(s.id, { as: 'release', outcome: 'done', evidence: 'apply ok', currentAttempt: async () => 2 }), 'plan_attempt_moved');
  await refused(() => C.releaseReconcile(s.id, { as: 'release', outcome: 'done', evidence: 'apply run 77 attempt 2 ok', currentAttempt: async () => 2 }), 'plan_attempt_moved');
  const d = await C.releaseReconcile(s.id, { as: 'release', outcome: 'done', evidence: 'apply run 77 consumed plan attempt 2', currentAttempt: async () => 2 });
  assert.equal(d.release.state, 'done');
});

test('F6 the service observer rechecks both attempts before any terminal result', async () => {
  const r = { ...(await runningRel({ deployRun: '20' })) };
  const moved = obsGh({ dsLater: { status: 'in_progress', run_attempt: 2 } });
  assert.equal((await E.observeRelease(r, { gh: moved })).state, 'unknown');
  const rerun = obsGh({ dsLater: { run_attempt: 2 } });
  assert.equal((await E.observeRelease(r, { gh: rerun })).state, 'unknown');
  assert.equal((await E.observeRelease(r, { gh: obsGh() })).state, 'done');
});

test('F7 a redispatch reconciled not_started restores its built source; only an explicit cancel drops it', async () => {
  const a = await start(await admit(svc('b1')), { digest: DIGEST });
  await C.releaseReconcile(a.id, { as: 'release', outcome: 'built', evidence: 'image pushed; no downstream' });
  const re = C.releaseRequest({ as: 'release', key: 'rd', kind: 'redispatch', env: 'dev', repo: TC, binary: 'trading-core', sha: SHA1, runtimeSha: SHA0,
    contentPrs: [`${TC}#141`], tag: tagFor(), digest: DIGEST, footprint: ['svc:trading-core'] }).release;
  await start(await admit(re));
  await C.releaseReconcile(re.id, { as: 'release', outcome: 'not_started', evidence: 'no deploy-dev-service run was created' });
  const states = Object.fromEntries(C.releaseList({}).releases.map(x => [x.request_key, x.state]));
  assert.deepEqual([states.b1, states.rd], ['built_not_deployed', 'cancelled']);
  await refused(() => admit(svc('next', { sha: SHA2, n: 34 })), 'built_not_deployed');
  C.releaseCancel(a.id, { as: 'master', note: 'abandon dev.33 image' });
  assert.equal((await admit(svc('next2', { sha: SHA2, n: 35 }))).state, 'admitted');
});

test('F8 start cannot rebind run ids recorded while admitted', async () => {
  const a = await admit(svc('r'));
  C.releaseRecord(a.id, { fence: a.fence, releaseRun: '100', deployRun: '200', tfRun: '300' });
  for (const k of ['releaseRun', 'deployRun', 'tfRun'])
    await refused(() => start(a, { [k]: '999' }), 'binding_mismatch');
  const s = await start(a, { releaseRun: '100', deployRun: '200' });
  assert.deepEqual([s.release_run, s.deploy_run, s.tf_run], ['100', '200', '300']);
});

test('F9 readiness re-evaluates local dependencies in its final transaction', async () => {
  C.depAdd('w', 'claim_free', 'env:dev');
  C.depAdd('w', 'pr_merged', `${TC}#1`);
  const r = await C.ready('w', { external: async () => { C.claim('env:dev', { as: 'cell:z' }); return { state: 'ready', why: 'merged', evidence: SHA1 }; } });
  assert.equal(r.ready, false);
  assert.equal(C.claims({ state: 'active' }).claims[0].resource, 'env:dev');
});

test('F10 workflow_dispatch release runs are unknown with an explicit reason, not a wrong identity', async () => {
  const r = { ...(await runningRel({})) };
  const o = await E.observeRelease(r, { gh: obsGh({ rel: { event: 'workflow_dispatch', head_branch: 'main-dev', head_sha: SHA2 } }) });
  assert.deepEqual([o.state, o.reason], ['unknown', 'workflow_dispatch provenance unsupported; reconcile manually']);
});

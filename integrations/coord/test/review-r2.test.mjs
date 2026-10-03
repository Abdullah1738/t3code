// Regression tests for review r2 of f4322be945, one per finding (#N in the test name).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as C from '../lib/coord.mjs';
import * as E from '../lib/evidence.mjs';
import { run } from '../lib/db.mjs';
import * as P from '../lib/pump.mjs';
import { fresh, advance, stubControl, SHA0, SHA1, SHA2, DIGEST, fakeGh, deployGh, deployLog, resetHooks, live, ranges } from './helpers.mjs';

const deliver = (...a) => P.deliver(...a);
const SHA3 = 'c'.repeat(40);
const TC = 'equicom-crypto/trading-core';
const ok = async () => ({ ok: true });
const refused = (fn, code) => assert.rejects(async () => fn(), e => { assert.equal(e.code, code, `${e.code}: ${e.message}`); return true; });
// `footprint` and `rangeEvidence` only matter to the previous contract; they let old-head runs reach the behaviour under test.
const svc = (key, o = {}) => C.releaseRequest({ as: 'crw', key, kind: 'service_release', env: 'dev', repo: TC, binary: 'trading-core',
  sha: SHA1, tag: 'dev.33', runtimeSha: SHA0, contentPrs: [`${TC}#141`], footprint: [`svc:${(o.binary ?? 'trading-core').toLowerCase()}`], rangeEvidence: 'x', ...o }).release;
const admit = async (r, o = {}) => (await C.releaseAdmit(r.id, { as: 'release', manual: true, verify: ok, ...o })).release;
const start = async (r, o = {}) => (await C.releaseStart(r.id, { as: 'release', fence: r.fence, verify: ok, ...o })).release;
const planAt = ago => async () => ({ startedAt: C.clock.now() - ago });
const tf = (key, o = {}) => C.releaseRequest({ as: 'release', key, kind: 'tf_apply', env: 'dev', plan: 'saved:900@1', footprint: ['env:dev'], ...o }).release;
const D = 'deploy-dev-service.yml';
const R = 'rollback-dev-service.yml';

let stub, dbPath;
beforeEach(async () => {
  dbPath = fresh();
  resetHooks();
  stub = await stubControl({ states: { 'T-master': 'idle' } });
  C.actorSet('master', { thread: 'T-master' });
  C.channelCreate('ops', { owner: 'master' });
});
afterEach(async () => { await stub.close(); C.close(); });

test('#1 a saved plan is always the full dev root: contradictory scope is refused and the full-root block applies', async () => {
  assert.throws(() => tf('a', { tfRoot: 'dev-risk' }), e => e.code === 'invalid');
  assert.throws(() => tf('b', { targets: ['module.ecs'] }), e => e.code === 'invalid');
  const p = tf('c');
  assert.deepEqual([p.tf_root, p.footprint], ['dev', ['env:dev', 'tf:dev']]);
  await refused(() => admit(p, { planRun: planAt(10) }), 'tf_full_root_blocked');
});

test('#2 admission and start validate the complete runtime..target range against current runtime', async () => {
  C.configure({ rangeResolver: null });
  await refused(() => admit(svc('n0')), 'range_unavailable');
  C.configure({ rangeResolver: async ({ base, head }) => ({ complete: true, prs: base === SHA0 && head === SHA1 ? [`${TC}#141`, `${TC}#150`] : [] }) });
  await refused(() => admit(svc('n1')), 'range_mismatch');
  await refused(() => admit(svc('n2', { contentPrs: [] })), 'range_mismatch');
  C.configure({ rangeResolver: async () => ({ complete: false, prs: [] }) });
  await refused(() => admit(svc('n3', { contentPrs: [] })), 'range_unavailable');
  resetHooks();
  live['trading-core'] = SHA3;
  await refused(() => admit(svc('n4')), 'runtime_moved');
  delete live['trading-core'];
  const a = await admit(svc('n5'));
  live['trading-core'] = SHA2; // rolled back between admission and start
  await refused(() => start(a), 'runtime_moved');
  C.configure({ runtime: async () => ({ state: 'unknown', reason: 'logs unreadable' }) });
  await refused(() => start(a), 'runtime_unknown');
});

test('#3 the same binary cannot run twice whatever the footprints; repo identity is case-insensitive', async () => {
  const a = await admit(svc('s1', { footprint: ['svc:trading-core'] }));
  await refused(() => admit(svc('s2', { footprint: ['env:dev'], sha: SHA2, tag: 'dev.34' })), 'footprint_busy');
  assert.deepEqual(a.footprint, ['env:dev', `repo:${TC}`, 'svc:trading-core']);
  assert.equal(svc('s1b', { footprint: ['env:dev'], sha: SHA3, tag: 'dev.36' }).footprint.includes('svc:trading-core'), true);
  await start(a);
  await C.releaseObserve(a.id, { observe: async () => ({ state: 'built_not_deployed', failure: 'no downstream' }) });
  const upper = svc('s3', { repo: 'Equicom-Crypto/Trading-Core', binary: 'Trading-Core', sha: SHA2, tag: 'dev.35' });
  assert.deepEqual([upper.repo, upper.binary], [TC, 'trading-core']);
  await refused(() => admit(upper), 'built_not_deployed');
});

test('#4 start requires the exact claim fences admission relied on, including the requester\'s', async () => {
  C.claim('env:dev', { as: 'crw', ttl: '10s', op: 'op-1' });
  const a = await admit(svc('f1'));
  assert.deepEqual(a.claim_fences, { 'env:dev': { owner: 'crw', fence: 1 } });
  advance(20);
  C.reconcile('env:dev', { as: 'master', outcome: 'not_started', evidence: 'nothing ran' });
  C.claim('env:dev', { as: 'crw', op: 'op-2' });
  await refused(() => start(a), 'stale_fence');
});

test('#5 an open QA window refuses env claims and env checks; QA cannot open over an env claim', () => {
  const q = C.qaOpen({ as: 'harness', env: 'dev' }).release;
  assert.throws(() => C.claim('env:dev', { as: 'cell:a', op: 'mutate' }), e => e.code === 'qa_window_open');
  assert.throws(() => C.check('env:dev', { as: 'cell:a', fence: 1 }), e => e.code === 'qa_window_open');
  C.claim('pr:x#1', { as: 'cell:a' });
  C.qaClose(q.id, { as: 'harness' });
  C.claim('env:dev', { as: 'cell:a' });
  assert.throws(() => C.qaOpen({ as: 'harness', env: 'dev' }), e => e.code === 'claimed');
});

test('#6 a plan cannot be resubmitted to dodge staleness; its age comes from the plan run, not the request', async () => {
  C.setFlag('tf_full_root_blocked', false, { as: 'master' });
  const old = tf('t0', { plan: 'saved:900@1' });
  const p1 = await admit(tf('t1', { plan: 'saved:901@1' }), { planRun: planAt(5) });
  await start(p1);
  C.releaseReconcile(p1.id, { as: 'release', outcome: 'done', evidence: 'run 901 attempt 1 apply ok' });
  await refused(() => admit(old, { planRun: planAt(50) }), 'stale_plan');
  assert.throws(() => tf('t0-again', { plan: 'saved:900@1' }), e => e.code === 'conflict');
  advance(1000);
  const fresh2 = tf('t2', { plan: 'saved:900@2' });
  await refused(() => admit(fresh2, { planRun: async () => ({ startedAt: C.tfRootGen('dev').bumped_at - 1 }) }), 'stale_plan');
});

test('#7 service releases that apply Terraform conflict with and invalidate plans of those roots', async () => {
  C.setFlag('tf_full_root_blocked', false, { as: 'master' });
  const reg = svc('r1', { repo: 'Equicom-Crypto/registry', binary: 'registry', contentPrs: [] });
  ranges[SHA1] = [];
  assert.ok(reg.footprint.includes('tf:dev'));
  const risk = svc('r2', { repo: 'Equicom-Crypto/risk-liquidation-latest', binary: 'risk-liquidation', contentPrs: [] });
  assert.ok(risk.footprint.includes('tf:dev-risk-liquidation') && risk.footprint.includes('tf:dev-core-capacity'));
  const plan = tf('t1');
  const a = await admit(reg);
  await refused(() => admit(plan, { planRun: planAt(10) }), 'footprint_busy');
  advance(5);
  await start(a);
  assert.equal(C.tfRootGen('dev').gen, 1);
  await C.releaseObserve(a.id, { observe: async () => ({ state: 'done' }) });
  await refused(() => admit(plan, { planRun: planAt(10) }), 'stale_plan');
});

test('#8 start rechecks the repo-wide built blocker', async () => {
  const a = await start(await admit(svc('b1')));
  // Same repo, other binary: the intrinsic repo lock already refuses it while the first is running.
  await refused(() => admit(svc('b2', { binary: 'trading-core-executor', sha: SHA2, tag: 'dev.34' })), 'footprint_busy');
  await C.releaseObserve(a.id, { observe: async () => ({ state: 'done' }) });
  const other = await admit(svc('b3', { binary: 'trading-core-executor', sha: SHA2, tag: 'dev.34' }));
  // A built row of the repo appears after admission (e.g. a reconcile of an earlier run); start must see it.
  run("UPDATE releases SET state='built_not_deployed' WHERE id=?", a.id);
  await refused(() => start(other), 'built_not_deployed');
});

test('#9 Terraform/migration plan identities are exact; no log substring matching is left', async () => {
  for (const plan of ['saved:9', 'scope:iam', 'saved:9@x'])
    assert.throws(() => tf(`p-${plan}`, { plan }), e => e.code === 'invalid', plan);
  const mig = o => C.releaseRequest({ as: 'release', key: `m${o.plan}`, kind: 'migration', env: 'dev', ...o });
  assert.throws(() => mig({ plan: '2026-10-01-markets.sql' }), e => e.code === 'invalid');
  assert.equal(mig({ plan: `2026-10-01-markets.sql@${'e'.repeat(64)}` }).release.footprint.includes('env:dev'), true);
  assert.equal(E.EXEC_RULES, undefined);
  const r = { kind: 'tf_apply', environment: 'dev', plan_id: 'saved:9@1', tf_run: '900' };
  assert.equal((await E.observeRelease(r, { gh: fakeGh([]) })).state, 'running');
  await refused(() => E.planRun('saved:9@1', { gh: fakeGh([[/runs\/9\/attempts\/1$/, { path: '.github/workflows/lint.yml', status: 'completed', conclusion: 'success' }]]) }), 'plan_unverified');
});

const FE = 'equicom-crypto/crypko-frontend';
const feRelease = id => ({ ...C.releaseRequest({ as: 'crw', key: `fe${id}`, kind: 'frontend_release', env: 'dev', repo: FE, binary: 'crypko-frontend',
  sha: SHA1, runtimeSha: SHA0, contentPrs: [`${FE}#9`] }).release, deploy_run: String(id) });
const feGh = (id, o) => deployGh({ x: [{ id, started: '2026-10-03T00:00:00Z', head: SHA1, path: '.github/workflows/deploy-dev.yml', ...o }] },
  { repo: FE, extra: [[/compare\//, { status: 'identical' }]] });

test('#10 frontend deployment proof only comes from the configured deploy workflow that ran a deploy job', async () => {
  assert.equal((await E.observeRelease(feRelease(55), { gh: feGh(55) })).state, 'done');
  assert.equal((await E.observeRelease(feRelease(56), { gh: feGh(56, { path: '.github/workflows/lint.yml' }) })).state, 'unknown');
  const skipped = feGh(57, { jobs: [{ name: 'Authorize manual run', conclusion: 'success' }, { name: 'deploy', conclusion: 'skipped' }] });
  assert.equal((await E.observeRelease(feRelease(57), { gh: skipped })).state, 'unknown');
});

const relGh = o => fakeGh([
  [/actions\/runs\/(\d+)\/attempts\/1\/jobs/, { jobs: [{ id: 1, status: 'completed', conclusion: 'success', run_attempt: 1, steps: [{ name: 'Build and push image', conclusion: o.publish ?? 'success' }] }] }],
  [/actions\/jobs\/1\/logs/, 'no downstream link'],
  [/actions\/runs\/10$/, { id: 10, path: `.github/workflows/${o.wf ?? 'release.yml'}`, status: 'completed', conclusion: 'success',
    head_sha: o.head ?? SHA1, head_branch: 'dev.33', run_attempt: 1, updated_at: '2026-01-01T00:00:00Z' }],
]);

test('#11 built classification needs the repo release workflow at the right head with a successful image push', async () => {
  const r = { ...svc('b11'), state: 'running', release_run: '10', updated_at: 0 };
  const obs = o => E.observeRelease(r, { gh: relGh(o), now: Date.parse('2026-02-01') / 1000 });
  assert.equal((await obs({})).state, 'built_not_deployed');
  assert.equal((await obs({ wf: 'lint.yml' })).state, 'unknown');
  assert.equal((await obs({ head: SHA2 })).state, 'unknown');
  assert.equal((await obs({ publish: 'skipped' })).state, 'unknown');
});

test('#12 runtime discovery includes rollback-dev-service runs', async () => {
  const gh = deployGh({
    [D]: [{ id: 11, started: '2026-10-02T00:00:00Z', log: deployLog('trading-core', 'dev.2', SHA2) }],
    [R]: [{ id: 12, started: '2026-10-03T00:00:00Z', log: deployLog('trading-core', 'dev.1', SHA1) }],
  });
  const rt = await E.serviceRuntime({ binary: 'trading-core', gh });
  assert.deepEqual([rt.state, rt.tag, rt.run], ['known', 'dev.1', '12']);
});

test('#13 an old run rerun after 100+ newer runs is found by paging; an uncovered window is unknown', async () => {
  const at = i => `2026-09-${String(10 + Math.floor(i / 10)).padStart(2, '0')}T0${i % 10}:00:00Z`;
  const newer = Array.from({ length: 120 }, (_, i) => ({ id: 1000 + i, created: at(i), started: at(i), log: deployLog('registry', 'dev.9', SHA3) }));
  newer[119].log = deployLog('trading-core', 'dev.2', SHA2); // newest created: what a single page would report
  const rerun = { id: 5, attempt: 2, created: '2026-09-01T00:00:00Z', started: '2026-10-01T00:00:00Z', log: deployLog('trading-core', 'dev.1', SHA1) };
  const rt = await E.serviceRuntime({ binary: 'trading-core', gh: deployGh({ [D]: [...newer, rerun] }) });
  assert.deepEqual([rt.state, rt.tag], ['known', 'dev.1']);
  const capped = await E.serviceRuntime({ binary: 'trading-core', gh: deployGh({ [D]: [...newer, rerun] }), maxPages: 1 });
  assert.equal(capped.state, 'unknown');
});

test('#14 skipped jobs are not log-fetched; other unreadable jobs still fail closed', async () => {
  const jobs = [{ name: 'Authorize manual run', conclusion: 'skipped', steps: [], log: new Error('HTTP 404') }, { name: 'deploy' }];
  const rt = await E.serviceRuntime({ binary: 'trading-core', gh: deployGh({ [D]: [{ id: 30, started: '2026-10-03T00:00:00Z', jobs, log: deployLog('trading-core', 'dev.5', SHA1) }] }) });
  assert.deepEqual([rt.state, rt.tag], ['known', 'dev.5']);
  const bad = [{ name: 'Authorize manual run', conclusion: 'success', log: new Error('HTTP 404') }, { name: 'deploy' }];
  const rt2 = await E.serviceRuntime({ binary: 'trading-core', gh: deployGh({ [D]: [{ id: 31, started: '2026-10-03T00:00:00Z', jobs: bad, log: deployLog('trading-core', 'dev.5', SHA1) }] }) });
  assert.equal(rt2.state, 'unknown');
});

test('#15 jobs come from the observed attempt, and a rerun started meanwhile makes the result unknown', async () => {
  const gh = deployGh({ [D]: [{ id: 40, attempt: 2, started: '2026-10-03T00:00:00Z', log: deployLog('trading-core', 'dev.7', SHA1) }] });
  const rt = await E.serviceRuntime({ binary: 'trading-core', gh });
  assert.deepEqual([rt.state, rt.attempt], ['known', 2]);
  assert.ok(gh.calls.some(c => c.includes('runs/40/attempts/2/jobs')));
  assert.ok(!gh.calls.some(c => /runs\/40\/jobs/.test(c)));
  const racing = deployGh({ [D]: [{ id: 41, started: '2026-10-03T00:00:00Z', log: deployLog('trading-core', 'dev.8', SHA1) }] },
    { extra: [[/actions\/runs\/41$/, { id: 41, status: 'in_progress', run_attempt: 2 }]] });
  assert.equal((await E.serviceRuntime({ binary: 'trading-core', gh: racing })).state, 'unknown');
  const mixed = deployGh({ [D]: [{ id: 42, started: '2026-10-03T00:00:00Z', jobs: [{ run_attempt: 2 }], log: deployLog('trading-core', 'dev.9', SHA1) }] });
  assert.equal((await E.serviceRuntime({ binary: 'trading-core', gh: mixed })).state, 'unknown');
});

test('#16 a running release that never dispatched is reconciled by release/master, keeping exclusion until then', async () => {
  const a = await start(await admit(svc('c1')));
  await refused(() => admit(svc('c2', { sha: SHA2, tag: 'dev.34' })), 'footprint_busy');
  assert.throws(() => C.releaseReconcile(a.id, { as: 'crw', outcome: 'not_started', evidence: 'x' }), e => e.code === 'forbidden');
  assert.throws(() => C.releaseReconcile(a.id, { as: 'release', outcome: 'not_started' }), e => e.code === 'invalid');
  C.releaseReconcile(a.id, { as: 'release', outcome: 'still_running', evidence: 'tag push in flight' });
  await refused(() => admit(svc('c3', { sha: SHA2, tag: 'dev.34' })), 'footprint_busy');
  const r = C.releaseReconcile(a.id, { as: 'master', outcome: 'not_started', evidence: 'no tag dev.33 on origin; no release run' }).release;
  assert.equal(r.state, 'cancelled');
  assert.equal((await admit(svc('c4', { sha: SHA2, tag: 'dev.34' }))).state, 'admitted');
});

test('#17 service releases need a tag up front, and a built release can get its tag and digest bound from evidence', async () => {
  assert.throws(() => svc('t0', { tag: undefined }), e => e.code === 'invalid');
  const a = await start(await admit(svc('t1')));
  C.releaseReconcile(a.id, { as: 'release', outcome: 'built', evidence: 'release run 10 pushed image; downstream never ran' });
  run('UPDATE releases SET tag=NULL WHERE id=?', a.id); // a legacy row without a bound tag
  const rec = C.releaseRecord(a.id, { as: 'release', evidence: 'ecr describe-images imageTag=dev.33', tag: 'dev.33', digest: DIGEST }).release;
  assert.deepEqual([rec.state, rec.tag, rec.image_digest], ['built_not_deployed', 'dev.33', DIGEST]);
  assert.throws(() => C.releaseRecord(a.id, { as: 'release', evidence: 'x', tag: 'dev.34' }), e => e.code === 'binding_mismatch');
  const re = C.releaseRequest({ as: 'release', key: 'rd', kind: 'redispatch', env: 'dev', repo: TC, binary: 'trading-core', sha: SHA1, runtimeSha: SHA0, contentPrs: [`${TC}#141`], tag: 'dev.33', digest: DIGEST }).release;
  assert.equal((await start(await admit(re))).state, 'running');
});

test('#18 readiness is false when the dependency set changed while it was being checked', async () => {
  const d1 = C.depAdd('w', 'pr_merged', `${TC}#1`).dep;
  C.depAdd('w', 'pr_merged', `${TC}#2`);
  const killFirst = async d => {
    if (d.ref.endsWith('#2')) C.depSet(d1.id, { state: 'dead', evidence: 'abandoned' });
    return { state: 'ready', why: 'merged', evidence: SHA1 };
  };
  assert.equal((await C.ready('w', { external: killFirst })).ready, false);
  C.depAdd('w2', 'pr_merged', `${TC}#3`);
  const addOne = async () => { C.depAdd('w2', 'manual', 'late'); return { state: 'ready', evidence: 'x' }; };
  assert.equal((await C.ready('w2', { external: addOne })).ready, false, 'a dependency added during the check');
});

test('#19 unsupported Terraform scopes are refused at request time', () => {
  // Shaped so the previous request contract (root, full scope, generation) accepted it.
  const r = (() => { try { return tf('ws', { plan: 'scope:ws-gateway-streamer-autoscaling', tfRoot: 'dev', fullRoot: true, rootGen: 0 }); } catch (e) { return e; } })();
  assert.equal(r.code, 'invalid', `accepted: ${JSON.stringify(r)}`);
});

test('#20 flag values must be exactly on or off', () => {
  C.close();
  const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), ...args],
    { env: { ...process.env, COORD_DB: dbPath }, encoding: 'utf8' });
  for (const v of [['onn'], []]) {
    const r = cli('flag', 'tf_full_root_blocked', ...v, '--as', 'master');
    assert.equal(r.status, 1, v.join());
    assert.equal(JSON.parse(r.stdout).error.code, 'invalid');
  }
  C.open(dbPath);
  assert.equal(C.flag('tf_full_root_blocked'), true);
});

test('#21 reminders re-read each row before sending and are not starved by paused rows', async () => {
  const s1 = C.post('ops', { as: 'crw', kind: 'status', key: 'r1', summary: 'one', to: ['master'] }).seq;
  const s2 = C.post('ops', { as: 'crw', kind: 'status', key: 'r2', summary: 'two', to: ['master'] }).seq;
  await deliver({ cfg: stub.cfg });
  advance(C.DEFAULTS.unackedAfter + 1);
  const sent = [];
  const send = async () => { sent.push(1); if (sent.length === 1) C.ack('master', [s2]); return {}; };
  const d = await deliver({ cfg: stub.cfg, send });
  assert.equal(sent.length, 1, 'the reminder for the acked event was not sent');
  assert.deepEqual(d.reminded.map(x => x.seq), [s1]);

  for (let i = 0; i < 55; i++) C.post('ops', { as: 'crw', kind: 'status', key: `p${i}`, summary: 's', env: 'dev', to: ['master'] });
  const stg = C.post('ops', { as: 'crw', kind: 'status', key: 'stg', summary: 's', env: 'staging', to: ['master'] }).seq;
  await deliver({ cfg: stub.cfg, limit: 100 });
  C.setMode('pause', { scope: 'env:dev', as: 'master', reason: 'r' });
  advance(C.DEFAULTS.unackedAfter + 1);
  const r = await deliver({ cfg: stub.cfg });
  assert.deepEqual(r.reminded.map(x => x.seq), [stg]);
});

test('#22 architecture work reconciled done is closed out by the new holder with commit evidence', () => {
  const req = C.archRequest({ as: 'crw', kind: 'drift_audit', repos: [TC], pins: { [TC]: SHA1 } }).request;
  const f1 = C.claim(C.ARCH_RESOURCE, { as: 'w1', ttl: '1s' }).fence;
  C.archTake(req.id, { as: 'w1', fence: f1 });
  advance(2);
  C.reconcile(C.ARCH_RESOURCE, { as: 'master', outcome: 'done', evidence: 'broker commit abc pushed' });
  const f2 = C.claim(C.ARCH_RESOURCE, { as: 'w2' }).fence;
  assert.throws(() => C.archCloseout(req.id, { as: 'w2', fence: f2, commits: 'abc' }), e => e.code === 'invalid');
  const done = C.archCloseout(req.id, { as: 'w2', fence: f2, commits: 'abc', evidence: 'git log origin/main shows abc' }).request;
  assert.deepEqual([done.state, done.result_commits], ['done', '["abc"]']);
});

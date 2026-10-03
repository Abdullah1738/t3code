// Regression tests for review r1 of 6db02528f2, one per finding (#N in the test name).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../lib/coord.mjs';
import * as E from '../lib/evidence.mjs';
import { run } from '../lib/db.mjs';
import * as P from '../lib/pump.mjs';

const deliver = (...a) => P.deliver(...a);
const pump = (...a) => P.pump(...a);
import { fresh, advance, stubControl, SHA0, SHA1, SHA2, DIGEST, fakeGh, deployGh, deployLog, resetHooks, testHooks, ranges, tagFor } from './helpers.mjs';

const DIGEST2 = `sha256:${'d'.repeat(64)}`;
const TC = 'equicom-crypto/trading-core';
const ok = async () => ({ ok: true });
const refused = (fn, code) => assert.rejects(async () => fn(), e => { assert.equal(e.code, code, `${e.code}: ${e.message}`); return true; });
const svc = (key, o = {}) => C.releaseRequest({ as: 'crw', key, kind: 'service_release', env: 'dev', repo: TC, binary: 'trading-core',
  sha: SHA1, runtimeSha: SHA0, contentPrs: [`${TC}#141`], ...o, n: undefined, tag: o.tag ?? tagFor(o.binary, o.n ?? 33, o.env) }).release;
const admitStart = async (r, o = {}) => {
  const a = (await C.releaseAdmit(r.id, { as: 'release', manual: true, verify: ok, ...o })).release;
  return (await C.releaseStart(r.id, { as: 'release', fence: a.fence, verify: ok, ...o })).release;
};
const built = async (key, o = {}) => {
  const r = await admitStart(svc(key, o), { ...(o.noDigest ? {} : { digest: DIGEST }) });
  return (await C.releaseObserve(r.id, { observe: async () => ({ state: 'built_not_deployed', failure: 'downstream never ran' }) })).release;
};
const tf = (key, o = {}) => C.releaseRequest({ as: 'release', key, kind: 'tf_apply', env: 'dev', plan: 'saved:900@1', ...o }).release;
const plans = new Map();
// A fake saved-plan run that started `ago` seconds before the first lookup; later lookups see the same run.
const planAt = ago => async id => { if (!plans.has(id)) plans.set(id, C.clock.now() - ago); return { startedAt: plans.get(id) }; };

let stub;
beforeEach(async () => {
  fresh();
  resetHooks();
  plans.clear();
  C.configure({ planRun: planAt(10) });
  stub = await stubControl({ states: { 'T-master': 'idle', 'T-shared': 'idle' } });
  C.actorSet('master', { thread: 'T-master' });
  C.channelCreate('ops', { owner: 'master' });
});
afterEach(async () => { await stub.close(); C.close(); });

test('#1 an expired claim cannot be released; it must be reconciled first', () => {
  C.claim('pr:x#1', { as: 'cell:a', ttl: '1s', op: 'merge-7' });
  advance(2);
  assert.throws(() => C.release('pr:x#1', { as: 'cell:a', fence: 1 }), e => e.code === 'reconcile_required');
  assert.equal(C.claims({ state: 'reconcile_required' }).claims.length, 1);
  assert.throws(() => C.claim('pr:x#1', { as: 'cell:b' }), e => e.code === 'reconcile_required');
});

test('#2 an expired env claim held by an admitter blocks admission by anyone', async () => {
  C.claim('env:dev', { as: 'release', ttl: '1s', op: 'tf-run-5' });
  advance(2);
  const r = svc('a2');
  await refused(() => C.releaseAdmit(r.id, { as: 'crw', verify: ok }), 'reconcile_required');
  assert.equal(C.claims({ state: 'reconcile_required' }).claims[0].resource, 'env:dev');
  await refused(() => C.releaseAdmit(r.id, { as: 'release', verify: ok }), 'reconcile_required');
  C.reconcile('env:dev', { as: 'master', fence: 1, outcome: 'done', evidence: 'tf-run-5 finished' });
  const a = (await C.releaseAdmit(r.id, { as: 'release', verify: ok })).release;
  run("INSERT OR REPLACE INTO claims (resource,owner,fence,state,lease_until) VALUES ('env:dev','master',9,'active',?)", C.clock.now() + 1);
  advance(2);
  await refused(() => C.releaseStart(r.id, { as: 'crw', fence: a.fence, verify: ok }), 'reconcile_required');
});

test('guard for #2: the requester may hold its own footprint claim; a third party may not', async () => {
  C.claim('svc:trading-core', { as: 'crw', env: 'dev' });
  const r = svc('a2b');
  assert.equal((await C.releaseAdmit(r.id, { as: 'release', verify: ok })).release.state, 'admitted');
  C.claim('svc:edge-api', { as: 'cell:z', env: 'dev' });
  const r2 = svc('a2c', { repo: 'Equicom-Crypto/edge-api', binary: 'edge-api' });
  await refused(() => C.releaseAdmit(r2.id, { as: 'release', verify: ok }), 'claimed');
});

test('#3 content range is required and every PR needs positive gate evidence at admit and at start', async () => {
  assert.throws(() => svc('g0', { contentPrs: undefined }), e => e.code === 'invalid');
  assert.throws(() => svc('g1', { runtimeSha: undefined }), e => e.code === 'invalid');
  ranges[SHA1] = [];
  const empty = svc('g3', { contentPrs: [], repo: 'Equicom-Crypto/edge-api', binary: 'edge-api' });
  C.configure({ gateCheck: null });
  assert.equal((await C.releaseAdmit(empty.id, { as: 'release', verify: ok })).release.state, 'admitted', 'a resolver-verified empty range needs no gate hook');
  ranges[SHA2] = [`${TC}#141`, `${TC}#150`];
  const r = svc('g4', { sha: SHA2, n: 34, contentPrs: [`${TC}#141`, `${TC}#150`] });
  await refused(() => C.releaseAdmit(r.id, { as: 'release', verify: ok }), 'gate_unavailable');
  const only141 = async () => ({ prs: [{ pr: `${TC}#141`, ok: true, evidence: 'approved' }, { pr: `${TC}#150`, ok: false }] });
  await refused(() => C.releaseAdmit(r.id, { as: 'release', verify: ok, gateCheck: only141 }), 'gates_not_clear');
  const a = (await C.releaseAdmit(r.id, { as: 'release', verify: ok, gateCheck: testHooks.gateCheck })).release;
  assert.equal(JSON.parse(a.gate_evidence).prs.length, 2);
  await refused(() => C.releaseStart(r.id, { as: 'crw', fence: a.fence, verify: ok }), 'gate_unavailable');
  await refused(() => C.releaseStart(r.id, { as: 'crw', fence: a.fence, verify: ok, gateCheck: only141 }), 'gates_not_clear');
  assert.equal((await C.releaseStart(r.id, { as: 'crw', fence: a.fence, verify: ok, gateCheck: testHooks.gateCheck })).release.state, 'running');
});

test('#4 an open shared-dev QA window excludes every dev mutation regardless of footprint, both directions', async () => {
  const qa = C.qaOpen({ as: 'harness', env: 'dev', footprint: ['harness:baseline'] }).release;
  const r = svc('q1');
  await refused(() => C.releaseAdmit(r.id, { as: 'release', verify: ok }), 'qa_window_open');
  C.qaClose(qa.id, { as: 'harness' });
  const a = (await C.releaseAdmit(r.id, { as: 'release', verify: ok })).release;
  assert.throws(() => C.qaOpen({ as: 'harness', env: 'dev', footprint: ['harness:baseline'] }), e => e.code === 'env_busy');
  await C.releaseStart(r.id, { as: 'crw', fence: a.fence, verify: ok });
  assert.throws(() => C.qaOpen({ as: 'harness', env: 'dev', footprint: ['other'] }), e => e.code === 'env_busy');
});

test('#4 a QA window opened after admission blocks release start', async () => {
  const r = svc('q2');
  const a = (await C.releaseAdmit(r.id, { as: 'release', verify: ok })).release;
  run("UPDATE releases SET state='requested' WHERE id=?", r.id); // simulate the window racing in between admit and start
  C.qaOpen({ as: 'harness', env: 'dev', footprint: ['harness:baseline'] });
  run("UPDATE releases SET state='admitted' WHERE id=?", r.id);
  await refused(() => C.releaseStart(r.id, { as: 'crw', fence: a.fence, verify: ok }), 'qa_window_open');
});

test('#5 QA cannot open over a reconcile_required or foreign active env claim', () => {
  C.claim('env:dev', { as: 'release', ttl: '1s', op: 'tf-run-9' });
  advance(2);
  assert.throws(() => C.qaOpen({ as: 'harness', env: 'dev' }), e => e.code === 'reconcile_required');
  C.reconcile('env:dev', { as: 'master', fence: 1, outcome: 'done', evidence: 'run 9 ok' });
  C.claim('env:dev', { as: 'cell:a' });
  assert.throws(() => C.qaOpen({ as: 'harness', env: 'dev' }), e => e.code === 'claimed');
});

test('#6 full-root saved plans are blocked by default, clearable only by master, and rechecked at start', async () => {
  assert.throws(() => tf('t2b', { plan: 'tfplan-xyz' }), e => e.code === 'invalid');
  const full = tf('t3');
  assert.deepEqual(full.footprint, ['env:dev', 'tf:dev']);
  await refused(() => C.releaseAdmit(full.id, { as: 'release', manual: true, planRun: planAt(10) }), 'tf_full_root_blocked');
  assert.throws(() => C.setFlag('tf_full_root_blocked', false, { as: 'release' }), e => e.code === 'forbidden');
  C.setFlag('tf_full_root_blocked', false, { as: 'master', reason: 'FDB coordinator gate resolved' });
  const a = (await C.releaseAdmit(full.id, { as: 'release', manual: true, planRun: planAt(10) })).release;
  C.setFlag('tf_full_root_blocked', true, { as: 'release', reason: 're-blocked' });
  await refused(() => C.releaseStart(full.id, { as: 'release', fence: a.fence }), 'tf_full_root_blocked');
});

test('#7 a saved plan older than the root\'s last mutation is refused at admit and at start', async () => {
  C.setFlag('tf_full_root_blocked', false, { as: 'master' });
  const old = tf('p0', { plan: 'saved:900@1' });
  const p1 = tf('p1', { plan: 'saved:901@1' });
  const a1 = (await C.releaseAdmit(p1.id, { as: 'release', manual: true, planRun: planAt(5) })).release;
  await C.releaseStart(p1.id, { as: 'release', fence: a1.fence, tfRun: '1' });
  await C.releaseReconcile(p1.id, { as: 'release', outcome: 'done', evidence: 'run 1 attempt 1 apply ok', currentAttempt: async () => 1 });
  assert.equal(C.tfRootGen('dev').gen, 2);
  await refused(() => C.releaseAdmit(old.id, { as: 'release', manual: true, planRun: planAt(50) }), 'stale_plan');
  advance(100);
  const p2 = tf('p2', { plan: 'saved:902@1' });
  const a2 = (await C.releaseAdmit(p2.id, { as: 'release', manual: true, planRun: planAt(10) })).release;
  run("UPDATE tf_roots SET gen=gen+1, bumped_at=? WHERE root='dev'", C.clock.now()); // another mutation of the root in between
  await refused(() => C.releaseStart(p2.id, { as: 'release', fence: a2.fence }), 'stale_plan');
  assert.equal(C.releaseList({ state: 'superseded' }).releases.length, 2);
});

test('#8 Terraform/DDL/migration are never auto-classified; only release reconcile closes them', async () => {
  C.setFlag('tf_full_root_blocked', false, { as: 'master' });
  const rel = tf('o1');
  const a = (await C.releaseAdmit(rel.id, { as: 'release', manual: true, planRun: planAt(5) })).release;
  await C.releaseStart(rel.id, { as: 'release', fence: a.fence, tfRun: '77' });
  const o = await C.releaseObserve(rel.id, { observe: async () => ({ state: 'done' }) });
  assert.equal(o.release.state, 'running');
  assert.equal((await E.observeRelease({ ...rel, environment: 'dev' }, { gh: fakeGh([]) })).state, 'running');
  await assert.rejects(() => C.releaseReconcile(rel.id, { as: 'crw', outcome: 'done', evidence: 'x' }), e => e.code === 'forbidden');
  assert.equal((await C.releaseReconcile(rel.id, { as: 'release', outcome: 'done', evidence: 'run 77 attempt 1: Apply saved plan success', currentAttempt: async () => 1 })).release.state, 'done');
});

test('#9 dev evidence never satisfies other environments', async () => {
  assert.throws(() => svc('e0', { env: 'ephemeral:qa' }), e => e.code === 'env_unsupported');
  await assert.rejects(E.observeRelease({ ...svc('e1'), environment: 'ephemeral:qa' }, { gh: fakeGh([]) }), e => e.code === 'env_unsupported');
  await assert.rejects(E.serviceRuntime({ binary: 'trading-core', env: 'staging', gh: fakeGh([]) }), e => e.code === 'env_unsupported');
  const expect = { env: 'dev', binary: 'trading-core', git_sha: SHA1 };
  const ds = { id: 1, path: '.github/workflows/deploy-dev-service.yml', status: 'completed', conclusion: 'success' };
  const c = E.classify({ release: { status: 'completed', conclusion: 'success' }, published: true, downstream: ds, inputs: { ...expect, env: 'staging' }, expect });
  assert.equal(c.state, 'failed');
  assert.equal(E.parseRunInputs(deployLog('trading-core', 'dev.1', SHA1, { env: 'staging' })).env, 'staging');
});

const D = 'deploy-dev-service.yml';
test('#10 runtime follows the latest attempt, so a rollback rerun of an older run wins', async () => {
  const gh = deployGh({ [D]: [
    { id: 10, attempt: 2, created: '2026-10-01T00:00:00Z', started: '2026-10-03T00:00:00Z', log: deployLog('trading-core', 'dev.1', SHA1) },
    { id: 11, created: '2026-10-02T00:00:00Z', started: '2026-10-02T00:00:00Z', log: deployLog('trading-core', 'dev.2', SHA2) },
  ] });
  const rt = await E.serviceRuntime({ binary: 'trading-core', gh });
  assert.deepEqual([rt.state, rt.tag, rt.attempt], ['known', 'dev.1', 2]);
});

test('#11 an unreadable newer run makes runtime unknown instead of falling back', async () => {
  const older = { id: 11, started: '2026-10-02T00:00:00Z', log: deployLog('trading-core', 'dev.2', SHA2) };
  let next = 20;
  const newer = o => deployGh({ [D]: [{ id: next++, started: '2026-10-03T00:00:00Z', ...o }, older] });
  const rt = async o => E.serviceRuntime({ binary: 'trading-core', gh: newer(o) });
  assert.equal((await rt({ log: new Error('HTTP 502') })).state, 'unknown');
  assert.equal((await rt({ log: 'no inputs here' })).state, 'unknown', 'validation ran but its inputs cannot be read');
  assert.deepEqual(Object.values(await rt({ conclusion: 'failure', log: 'rejected', jobs: [{ steps: [{ name: 'Authorize', conclusion: 'failure' }, { name: 'Validate release tag', conclusion: 'skipped' }] }] }))
    .slice(0, 3), ['known', SHA2, 'dev.2'], 'a run that provably never reached validation changed nothing');
  assert.equal((await rt({ log: deployLog('registry', 'dev.9', SHA1) })).tag, 'dev.2', 'a positively identified other binary is skipped');
  assert.equal((await rt({ conclusion: 'failure', log: deployLog('trading-core', 'dev.3', SHA1) })).state, 'unknown', 'a newer failed deploy of the binary leaves runtime unknown');
});

test('#12 a frontend release is done only when the observed head contains the requested sha', async () => {
  const fe = C.releaseRequest({ as: 'crw', key: 'fe1', kind: 'frontend_release', env: 'dev', repo: 'Equicom-Crypto/crypko-frontend', binary: 'crypko-frontend',
    sha: SHA1, runtimeSha: SHA0, contentPrs: ['equicom-crypto/crypko-frontend#9'] }).release;
  const r = { ...fe, deploy_run: '55' };
  const gh = status => deployGh({ 'deploy-dev.yml': [{ id: 55, started: '2026-10-03T00:00:00Z', head: SHA2, path: '.github/workflows/deploy-dev.yml' }] },
    { repo: 'equicom-crypto/crypko-frontend', extra: [[new RegExp(`compare/${SHA2}\\.\\.\\.${SHA1}`), { status }]] });
  assert.equal((await E.observeRelease(r, { gh: gh('ahead') })).state, 'failed');
  assert.equal((await E.observeRelease(r, { gh: gh('diverged') })).state, 'failed');
  const d = await E.observeRelease(r, { gh: gh('behind') });
  assert.equal(d.state, 'done');
  assert.equal(d.readback.observed_head, SHA2);
});

test('#13 an observer result is dropped when the release changed while it ran', async () => {
  const r = await admitStart(svc('o13'));
  let release;
  const gate = new Promise(res => { release = res; });
  const p = C.releaseObserve(r.id, { observe: async () => { await gate; return { state: 'done', digest: DIGEST2 }; } });
  C.releaseRecord(r.id, { fence: r.fence, digest: DIGEST });
  release();
  const o = await p;
  assert.ok(o.pending);
  const cur = C.releaseList({ state: 'running' }).releases[0];
  assert.equal(cur.image_digest, DIGEST);
  await refused(() => C.releaseObserve(r.id, { observe: async () => ({ state: 'done', digest: DIGEST2 }) }), 'binding_mismatch');
});

test('#14 a built release without a digest can be bound from evidence by an admitter, then redispatched', async () => {
  const b = await built('b14', { noDigest: true });
  assert.equal(b.image_digest, null);
  assert.throws(() => C.releaseRecord(b.id, { as: 'crw', evidence: 'x', digest: DIGEST }), e => e.code === 'forbidden');
  assert.throws(() => C.releaseRecord(b.id, { as: 'release', digest: DIGEST }), e => e.code === 'invalid');
  const rec = C.releaseRecord(b.id, { as: 'release', evidence: 'ecr describe-images dev.33', digest: DIGEST }).release;
  assert.deepEqual([rec.state, rec.image_digest], ['built_not_deployed', DIGEST]);
  const re = C.releaseRequest({ as: 'release', key: 'r14', kind: 'redispatch', env: 'dev', repo: TC, binary: 'trading-core', sha: SHA1, runtimeSha: SHA0,
    contentPrs: [`${TC}#141`], tag: 'trading-core-docs1-dev.33', digest: DIGEST, footprint: ['svc:trading-core'] }).release;
  assert.equal((await admitStart(re)).state, 'running');
});

test('#15 binary is required and the built blocker is repo-wide', async () => {
  assert.throws(() => svc('n0', { binary: undefined }), e => e.code === 'invalid');
  await built('b15');
  const other = svc('n1', { binary: 'ws-gateway', sha: SHA2, footprint: ['svc:ws-gateway'] });
  await refused(() => C.releaseAdmit(other.id, { as: 'release', verify: ok }), 'built_not_deployed');
});

test('#16 a redispatch supersedes only its own source release, not other built rows', async () => {
  const tc = await built('b16tc');
  const other = await built('b16x', { repo: 'Equicom-Crypto/edge-api', binary: 'edge-api', contentPrs: [`${TC}#141`] });
  const re = C.releaseRequest({ as: 'release', key: 'r16', kind: 'redispatch', env: 'dev', repo: 'Equicom-Crypto/edge-api', binary: 'edge-api', sha: SHA1, runtimeSha: SHA0,
    contentPrs: [`${TC}#141`], tag: tagFor('edge-api'), digest: DIGEST }).release;
  await admitStart(re);
  const states = Object.fromEntries(C.releaseList({}).releases.map(r => [r.request_key, r.state]));
  assert.equal(states.b16tc, 'built_not_deployed');
  assert.equal(states.b16x, 'superseded');
  assert.equal(C.releaseList({ state: 'built_not_deployed' }).releases[0].id, tc.id);
  assert.ok(other);
});

test('#17 replaying the original release request stays idempotent after start and observation', async () => {
  const r = await admitStart(svc('i17'));
  await C.releaseObserve(r.id, { observe: async () => ({ state: 'done', digest: DIGEST }) });
  const again = C.releaseRequest({ as: 'crw', key: 'i17', kind: 'service_release', env: 'dev', repo: 'Equicom-Crypto/Trading-Core', binary: 'trading-core', sha: SHA1,
    tag: 'trading-core-docs1-dev.33', runtimeSha: SHA0, contentPrs: [`${TC}#141`] });
  assert.deepEqual([again.duplicate, again.release.id, again.release.state], [true, r.id, 'done']);
  assert.throws(() => svc('i17', { sha: SHA2 }), e => e.code === 'conflict');
});

test('#18 the pump re-reads each row before sending: pause, ack and retarget during a batch are honoured', async () => {
  const s1 = C.post('ops', { as: 'crw', kind: 'status', key: 'p1', summary: 'one', to: ['master'] }).seq;
  const s2 = C.post('ops', { as: 'crw', kind: 'status', key: 'p2', summary: 'two', to: ['master'] }).seq;
  const s3 = C.post('ops', { as: 'crw', kind: 'status', key: 'p3', summary: 'three', to: ['master'] }).seq;
  const sent = [];
  let n = 0;
  const send = async (cfg, thread, text) => {
    sent.push([thread, text.slice(0, 20)]);
    if (++n === 1) { C.ack('master', [s2]); C.actorSet('master', { thread: 'T-shared' }); }
    return { messageId: `m${n}` };
  };
  const d = await deliver({ cfg: stub.cfg, send });
  assert.equal(sent.length, 2, 'the acked second event was not sent');
  assert.equal(sent[1][0], 'T-shared', 'third went to the rebound thread');
  assert.deepEqual(d.sent.map(x => x.seq), [s3], 'the first was rebound mid-send, so it is not marked sent');
  const again = await deliver({ cfg: stub.cfg, send });
  assert.deepEqual(again.sent.map(x => x.seq), [s1]);
  assert.equal(sent.at(-1)[0], 'T-shared', 'the rebound first event is resent to the new thread');
  const t1 = C.post('ops', { as: 'crw', kind: 'status', key: 'p4', summary: 'four', to: ['master'] }).seq;
  C.post('ops', { as: 'crw', kind: 'status', key: 'p5', summary: 'five', to: ['master'] });
  n = 0;
  const pausing = async () => { if (++n === 1) C.setMode('pause', { as: 'master', reason: 'r' }); return {}; };
  const d2 = await deliver({ cfg: stub.cfg, send: pausing });
  assert.equal(n, 1);
  assert.deepEqual(d2.sent.map(x => x.seq), [t1]);
});

test('#19 held rows under pause do not starve deliverable control events or other environments', async () => {
  C.setMode('pause', { scope: 'env:dev', as: 'master', reason: 'r' });
  for (let i = 0; i < 60; i++) C.post('ops', { as: 'crw', kind: 'status', key: `dev${i}`, summary: 's', env: 'dev', to: ['master'] });
  const ctl = C.post('ops', { as: 'crw', kind: 'control', key: 'ctl', summary: 'c', env: 'dev', to: ['master'] }).seq;
  const stg = C.post('ops', { as: 'crw', kind: 'status', key: 'stg', summary: 's', env: 'staging', to: ['master'] }).seq;
  const d = await deliver({ cfg: stub.cfg });
  assert.deepEqual(d.sent.map(x => x.seq).sort((a, b) => a - b), [ctl, stg]);
  assert.equal(d.held, 60);
});

test('#20 delivery ids are unambiguous for colon-bearing event keys and actor ids', async () => {
  C.actorSet('a', { thread: 'T-shared' });
  C.actorSet('cell:a', { thread: 'T-shared' });
  C.post('ops', { as: 'crw', kind: 'status', key: 'operation:cell', summary: 'first', to: ['a'] });
  C.post('ops', { as: 'crw', kind: 'status', key: 'operation', summary: 'second', to: ['cell:a'] });
  assert.notEqual(C.deliveryId('operation:cell', 'a'), C.deliveryId('operation', 'cell:a'));
  assert.match(C.deliveryId('x', 'y'), /^coord:[0-9a-f]{64}$/);
  await deliver({ cfg: stub.cfg });
  assert.equal(stub.messages['T-shared'].length, 2);
});

test('#21 QA key reuse with a different binding is a conflict', () => {
  const fp = ['harness:baseline'];
  const q = C.qaOpen({ as: 'harness', env: 'dev', footprint: fp, key: 'qa-1' }).release;
  assert.equal(C.qaOpen({ as: 'harness', env: 'dev', footprint: fp, key: 'qa-1' }).release.id, q.id);
  assert.throws(() => C.qaOpen({ as: 'harness', env: 'ephemeral:x', footprint: fp, key: 'qa-1' }), e => e.code === 'conflict');
  assert.throws(() => C.qaOpen({ as: 'other', env: 'dev', footprint: fp, key: 'qa-1' }), e => e.code === 'conflict');
  svc('rel-key');
  assert.throws(() => C.qaOpen({ as: 'harness', env: 'ephemeral:y', footprint: fp, key: 'rel-key' }), e => e.code === 'conflict');
});

test('#22 a late readiness result does not resurrect a dependency set dead meanwhile', async () => {
  const d = C.depAdd('w22', 'pr_merged', `${TC}#1`).dep;
  let release;
  const gate = new Promise(res => { release = res; });
  const p = C.ready('w22', { external: async () => { await gate; return { state: 'ready', why: 'merged', evidence: SHA1 }; } });
  C.depSet(d.id, { state: 'dead', evidence: 'PR abandoned' });
  release();
  const r = await p;
  assert.equal(r.ready, false);
  assert.equal(r.deps[0].state, 'dead');
});

test('#23 drain is not reported when thread actors could not be checked', async () => {
  const rep = await C.drainReport({});
  assert.equal(rep.drained, false);
  assert.match(rep.inflight.threads[0].state, /^unknown/);
});

test('#24 a reconciled writer can be replaced: the new arch:broker holder takes over the request', () => {
  const req = C.archRequest({ as: 'crw', kind: 'drift_audit', repos: [TC], pins: { [TC]: SHA1 } }).request;
  const f1 = C.claim(C.ARCH_RESOURCE, { as: 'arch-author', ttl: '1s' }).fence;
  C.archTake(req.id, { as: 'arch-author', fence: f1 });
  advance(2);
  assert.throws(() => C.claim(C.ARCH_RESOURCE, { as: 'arch-author-2' }), e => e.code === 'reconcile_required');
  C.reconcile(C.ARCH_RESOURCE, { as: 'master', fence: f1, outcome: 'not_started', evidence: 'no broker commits since take' });
  const f2 = C.claim(C.ARCH_RESOURCE, { as: 'arch-author-2' }).fence;
  assert.throws(() => C.archDone(req.id, { as: 'arch-author-2', fence: f2, commits: 'x' }), e => e.code === 'forbidden');
  const t = C.archTransfer(req.id, { as: 'arch-author-2', fence: f2 }).request;
  assert.deepEqual([t.taken_by, t.fence], ['arch-author-2', f2]);
  assert.equal(C.archDone(req.id, { as: 'arch-author-2', fence: f2, commits: 'abc' }).request.state, 'done');
});

test('#24 transfer is refused while the previous writer is unreconciled or reconciled as done/still_running', () => {
  const req = C.archRequest({ as: 'crw', kind: 'doc_fix', repos: [TC], pins: { [TC]: SHA2 } }).request;
  const f1 = C.claim(C.ARCH_RESOURCE, { as: 'w1', ttl: '1s' }).fence;
  C.archTake(req.id, { as: 'w1', fence: f1 });
  advance(2);
  C.reconcile(C.ARCH_RESOURCE, { as: 'master', fence: f1, outcome: 'done', evidence: 'commit abc pushed' });
  const f2 = C.claim(C.ARCH_RESOURCE, { as: 'w2' }).fence;
  assert.throws(() => C.archTransfer(req.id, { as: 'w2', fence: f2 }), e => e.code === 'not_reconciled');
});

// ---------- settled open questions ----------

test('pump observes running releases, bounded per tick', async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await admitStart(svc(`pm${i}`, { repo: `Equicom-Crypto/${['edge-api', 'reporting', 'rewards'][i]}`, binary: ['edge-api', 'reporting', 'rewards'][i] }))).id);
  const seen = [];
  const out = await pump({ cfg: stub.cfg, observeLimit: 2, observe: async r => { seen.push(r.id); return { state: 'done' }; } });
  assert.deepEqual(seen, ids.slice(0, 2));
  assert.equal(out.observed.length, 2);
  await pump({ cfg: stub.cfg, observeLimit: 2, observe: async () => ({ state: 'unknown', why: 'logs unreadable' }) });
  assert.equal(C.releaseList({ state: 'running' }).releases[0].observe_note, 'unknown: logs unreadable');
  assert.equal(C.attention().unobserved.length, 1);
});

test('coord init seeds the crw actor idempotently; ensureActor never rebinds', () => {
  C.init();
  C.init();
  assert.equal(C.status().actors.filter(a => a.id === 'crw').length, 1);
  assert.equal(C.ensureActor('master', { thread: 'T-other' }).actor.thread_id, 'T-master');
});

test('an expired QA window keeps blocking until master or release closes it, and attention flags it', async () => {
  const q = C.qaOpen({ as: 'harness', env: 'dev', footprint: ['harness:baseline'], ttl: '1h' }).release;
  advance(7200);
  assert.equal(C.attention().expired_qa_windows[0].id, q.id);
  const r = svc('x1');
  await refused(() => C.releaseAdmit(r.id, { as: 'release', verify: ok }), 'qa_window_open');
  C.qaClose(q.id, { as: 'master' });
  assert.equal((await C.releaseAdmit(r.id, { as: 'release', verify: ok })).release.state, 'admitted');
});

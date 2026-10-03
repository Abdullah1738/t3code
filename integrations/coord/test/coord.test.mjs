import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as C from '../lib/coord.mjs';
import { deliver, threadState } from '../lib/pump.mjs';
import { classify, parseRunInputs } from '../lib/evidence.mjs';
import { fresh, advance, stubControl, SHA0, SHA1, SHA2, DIGEST, deployGh, deployLog, resetHooks, tagFor } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const ok = async () => ({ ok: true });
const stale = async () => ({ ok: false, reason: 'not on main-dev' });
const refused = async (fn, code) => {
  await assert.rejects(async () => fn(), e => { assert.equal(e.code, code, `${e.code}: ${e.message}`); return true; });
};

let stub, dbPath;
beforeEach(async () => {
  dbPath = fresh();
  resetHooks();
  stub = await stubControl({ states: { 'T-master': 'idle', 'T-parent': 'running', 'T-new': 'idle', 'T-arch': 'idle' } });
  C.actorSet('master', { thread: 'T-master' });
  C.actorSet('crw', { kind: 'process' });
  C.channelCreate('delivery', { owner: 'master' });
  C.memberAdd('delivery', 'master', { wake: true });
  C.memberAdd('delivery', 'crw');
});
afterEach(async () => { await stub.close(); C.close(); });

const cli = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, COORD_DB: dbPath, T3_CONTROL_URL: stub.cfg.url, T3_CONTROL_TOKEN: 'x' }, encoding: 'utf8' });
  return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
};

// ---------- duplicate messages ----------

test('same event_key twice is one event; a different body is a 409 conflict', () => {
  const a = C.post('delivery', { as: 'crw', kind: 'status', key: 'crw:deploy:66:done', summary: 'deployed dev.19' });
  const b = C.post('delivery', { as: 'crw', kind: 'status', key: 'crw:deploy:66:done', summary: 'deployed dev.19' });
  assert.equal(b.seq, a.seq);
  assert.equal(b.duplicate, true);
  assert.throws(() => C.post('delivery', { as: 'crw', kind: 'status', key: 'crw:deploy:66:done', summary: 'deployed dev.20' }),
    e => e.code === 'conflict' && e.extra.status === 409);
  assert.equal(C.inbox({ as: 'master' }).events.length, 1);
});

test('pump crash after send: the resend reuses the clientRequestId and Robob keeps one message', async () => {
  const { seq } = C.post('delivery', { as: 'crw', kind: 'status', key: 'k1', summary: 'hello' });
  let crash = true;
  const send = async (...a) => {
    const { sendToThread } = await import('../lib/pump.mjs');
    const r = await sendToThread(...a);
    if (crash) { crash = false; throw new Error('process died before marking sent'); }
    return r;
  };
  const first = await deliver({ cfg: stub.cfg, send });
  assert.equal(first.retry.length, 1);
  assert.equal((await deliver({ cfg: stub.cfg, send })).sent.length, 0, 'held until backoff');
  advance(200);
  const second = await deliver({ cfg: stub.cfg, send });
  assert.equal(second.sent.length, 1);
  assert.equal(stub.sends.length, 2);
  assert.equal(stub.sends[0].clientRequestId, C.deliveryId('k1', 'master'));
  assert.equal(stub.sends[1].clientRequestId, stub.sends[0].clientRequestId);
  assert.equal(stub.messages['T-master'].length, 1);
  assert.match(stub.messages['T-master'][0].messageId, new RegExp(encodeURIComponent(C.deliveryId('k1', 'master'))));
  assert.match(stub.sends[0].text, new RegExp(`^\\[coord delivery #${seq} from crw\\] hello`));
  assert.equal(stub.sends[0].mode, 'queue');
});

test('duplicate ack is a no-op; ack by a non-recipient is refused', () => {
  const { seq } = C.post('delivery', { as: 'master', kind: 'request', key: 'k2', summary: 'please review' });
  assert.deepEqual(C.ack('crw', [seq]).acked, [{ seq }]);
  const t = C.inbox({ as: 'crw' }).events[0].acked_at;
  assert.deepEqual(C.ack('crw', ['k2']).acked, [{ seq, already: true }]);
  assert.equal(C.inbox({ as: 'crw' }).events[0].acked_at, t);
  assert.throws(() => C.ack('master', [seq]), e => e.code === 'not_addressed');
});

test('process actors are pull-only and recipients exclude the sender', () => {
  const { recipients } = C.post('delivery', { as: 'master', kind: 'request', key: 'k3', summary: 'x' });
  assert.deepEqual(recipients, ['crw']);
  assert.equal(C.inbox({ as: 'crw', unacked: true }).events[0].delivery, 'skipped');
});

// ---------- claims ----------

test('claims: fencing is monotonic; expiry gives reconcile_required, never a silent handover', () => {
  const a = C.claim('pr:x#1', { as: 'cell:a', ttl: '1s', op: 'merge-run-7' });
  assert.equal(a.fence, 1);
  assert.throws(() => C.claim('pr:x#1', { as: 'cell:b' }), e => e.code === 'held');
  advance(2);
  assert.throws(() => C.claim('pr:x#1', { as: 'cell:b' }), e => e.code === 'reconcile_required' && e.extra.owner === 'cell:a' && e.extra.op_ref === 'merge-run-7');
  assert.equal(C.claims({ state: 'reconcile_required' }).claims.length, 1, 'expiry persisted despite the refusal');
  assert.throws(() => C.check('pr:x#1', { as: 'cell:a', fence: 1 }), e => e.code === 'reconcile_required');
  assert.throws(() => C.renew('pr:x#1', { as: 'cell:a', fence: 1 }), e => e.code === 'reconcile_required');
  assert.throws(() => C.reconcile('pr:x#1', { as: 'cell:b', fence: 1, outcome: 'done', evidence: 'x' }), e => e.code === 'forbidden');
  C.reconcile('pr:x#1', { as: 'master', fence: 1, outcome: 'still_running', evidence: 'run 7 in progress' });
  assert.throws(() => C.claim('pr:x#1', { as: 'cell:b' }), e => e.code === 'reconcile_required');
  C.reconcile('pr:x#1', { as: 'master', fence: 1, outcome: 'done', evidence: 'run 7 merged abc' });
  const b = C.claim('pr:x#1', { as: 'cell:b' });
  assert.equal(b.fence, 2);
  assert.throws(() => C.check('pr:x#1', { as: 'cell:a', fence: 1 }), e => e.code === 'stale_fence');
  assert.throws(() => C.renew('pr:x#1', { as: 'cell:b', fence: 1 }), e => e.code === 'stale_fence');
  assert.equal(C.check('pr:x#1', { as: 'cell:b', fence: 2 }).fence, 2);
  C.release('pr:x#1', { as: 'cell:b', fence: 2 });
  assert.throws(() => C.release('pr:x#1', { as: 'cell:b', fence: 2 }), e => e.code === 'stale_fence');
  assert.equal(C.claim('pr:x#1', { as: 'cell:a' }).fence, 3);
});

// ---------- release admission ----------

const svc = (key, o = {}) => C.releaseRequest({ as: 'crw', key, kind: 'service_release', env: 'dev', repo: 'Equicom-Crypto/trading-core',
  binary: 'trading-core', sha: SHA1, runtimeSha: SHA0, contentPrs: ['equicom-crypto/trading-core#141'], ...o, n: undefined, tag: o.tag ?? tagFor(o.binary, o.n ?? 33, o.env) }).release;

test('release admission binds repo+sha+digest+plan+env; stale sha is refused and superseded', async () => {
  const r = svc('crw:deploy:1');
  assert.equal(C.releaseRequest({ as: 'crw', key: 'crw:deploy:1', kind: 'service_release', env: 'dev', repo: 'Equicom-Crypto/trading-core',
    binary: 'trading-core', sha: SHA1, tag: 'trading-core-docs1-dev.33', runtimeSha: SHA0, contentPrs: ['equicom-crypto/trading-core#141'] }).duplicate, true);
  assert.throws(() => svc('crw:deploy:1', { sha: SHA2 }), e => e.code === 'conflict');
  const s = svc('crw:deploy:2', { repo: 'Equicom-Crypto/reporting', binary: 'reporting' });
  await refused(() => C.releaseAdmit(s.id, { as: 'release', verify: stale }), 'stale_revision');
  assert.equal(C.releaseList({ state: 'superseded' }).releases[0].id, s.id);
  await refused(() => C.releaseAdmit(s.id, { as: 'release', verify: ok }), 'bad_state');

  const a = (await C.releaseAdmit(r.id, { as: 'release', verify: ok })).release;
  assert.equal(a.state, 'admitted');
  await refused(() => C.releaseStart(r.id, { as: 'crw', fence: a.fence, sha: SHA2, verify: ok }), 'binding_mismatch');
  await refused(() => C.releaseStart(r.id, { as: 'crw', fence: a.fence, env: 'prod', verify: ok }), 'binding_mismatch');
  await refused(() => C.releaseStart(r.id, { as: 'crw', fence: a.fence + 1, verify: ok }), 'stale_fence');
  await refused(() => C.releaseStart(r.id, { as: 'crw', fence: a.fence, tag: 'trading-core-docs1-dev.34', verify: ok }), 'binding_mismatch');
  const st = (await C.releaseStart(r.id, { as: 'crw', fence: a.fence, sha: SHA1, tag: 'trading-core-docs1-dev.33', releaseRun: '1', verify: ok })).release;
  assert.equal(st.state, 'running');
  assert.equal(st.tag, 'trading-core-docs1-dev.33');
});

test('a head that moves after admission blocks release start', async () => {
  const r = svc('crw:deploy:3');
  const a = (await C.releaseAdmit(r.id, { as: 'release', verify: ok })).release;
  await refused(() => C.releaseStart(r.id, { as: 'crw', fence: a.fence, verify: stale }), 'head_moved');
  assert.equal(C.releaseList({ state: 'superseded' }).releases.length, 1);
});

test('a saved plan started before the last mutation of its root is superseded; full-root apply is blocked by default', async () => {
  const plans = { 'saved:11@1': 100, 'saved:12@1': 200 };
  const planRun = async id => ({ startedAt: C.clock.now() - plans[id] });
  const tf = (key, plan) => C.releaseRequest({ as: 'release', key, kind: 'tf_apply', env: 'dev', plan }).release;
  const p1 = tf('tf1', 'saved:11@1');
  const p2 = tf('tf2', 'saved:12@1');
  assert.deepEqual(p1.footprint, ['env:dev', 'tf:dev']);
  assert.equal(C.flag('tf_full_root_blocked'), true, 'blocked until master clears it');
  await refused(() => C.releaseAdmit(p1.id, { as: 'release', manual: true, planRun }), 'tf_full_root_blocked');
  C.setFlag('tf_full_root_blocked', false, { as: 'master' });
  await refused(() => C.releaseAdmit(p1.id, { as: 'release', planRun }), 'manual_admit_required');
  const a1 = (await C.releaseAdmit(p1.id, { as: 'release', manual: true, planRun })).release;
  await C.releaseStart(p1.id, { as: 'release', fence: a1.fence, tfRun: '5', planRun });
  assert.equal(C.tfRootGen('dev').gen, 1);
  await refused(() => C.releaseAdmit(p2.id, { as: 'release', manual: true, planRun }), 'stale_plan');
  assert.equal(C.releaseList({ state: 'superseded' }).releases[0].id, p2.id);
});

test('overlapping footprints and open QA windows block admission; built_not_deployed blocks new tags until redispatch', async () => {
  const qa = C.qaOpen({ as: 'harness', env: 'dev' }).release;
  const r = svc('crw:deploy:4');
  await refused(() => C.releaseAdmit(r.id, { as: 'release', verify: ok }), 'qa_window_open');
  C.qaClose(qa.id, { as: 'harness' });
  const a = (await C.releaseAdmit(r.id, { as: 'release', verify: ok })).release;
  await C.releaseStart(r.id, { as: 'crw', fence: a.fence, digest: DIGEST, releaseRun: '10', verify: ok });
  const obs = await C.releaseObserve(r.id, { observe: async () => ({ state: 'built_not_deployed', failure: 'downstream cancelled before any job' }) });
  assert.equal(obs.release.state, 'built_not_deployed');
  const next = svc('crw:deploy:5', { sha: SHA2, n: 34 });
  await refused(() => C.releaseAdmit(next.id, { as: 'release', verify: ok }), 'built_not_deployed');
  const redis = (key, tag) => C.releaseRequest({ as: 'release', key, kind: 'redispatch', env: 'dev', repo: 'Equicom-Crypto/trading-core', binary: 'trading-core',
    sha: SHA1, runtimeSha: SHA0, contentPrs: ['equicom-crypto/trading-core#141'], tag, digest: DIGEST }).release;
  const bad = redis('redis:x', 'trading-core-docs1-dev.34');
  await refused(() => C.releaseAdmit(bad.id, { as: 'release', manual: true, verify: ok }), 'no_built_release');
  const re = redis('redis:1', 'trading-core-docs1-dev.33');
  await refused(() => C.releaseAdmit(re.id, { as: 'crw', verify: ok }), 'manual_admit_required');
  const ra = (await C.releaseAdmit(re.id, { as: 'release', manual: true, verify: ok })).release;
  await refused(() => C.releaseStart(re.id, { as: 'release', fence: ra.fence, tag: 'trading-core-docs1-dev.34', verify: ok }), 'binding_mismatch');
  await C.releaseStart(re.id, { as: 'release', fence: ra.fence, deployRun: '99', verify: ok });
  assert.equal(C.releaseList({ state: 'built_not_deployed' }).releases.length, 0);
});

test('evidence classification: zero-job cancelled downstream is built_not_deployed, not failed or done', () => {
  const rel = { status: 'completed', conclusion: 'success' };
  const expect = { env: 'dev', binary: 'trading-core', tag: 'trading-core-docs1-dev.33', digest: DIGEST, git_sha: SHA1 };
  const ds = (conclusion) => ({ id: 1, path: '.github/workflows/deploy-dev-service.yml', status: 'completed', conclusion });
  const c = o => classify({ release: rel, published: true, expect, ...o }).state;
  assert.equal(c({ downstream: ds('cancelled'), downstreamJobs: 0 }), 'built_not_deployed');
  assert.equal(c({ downstream: null, dispatched: 'no' }), 'built_not_deployed');
  assert.equal(c({ downstream: null, dispatched: 'no', published: false }), 'failed');
  assert.equal(c({ downstream: null, releaseAgeSec: 4000 }), 'unknown', 'dispatch ran but no downstream found: reconcile by hand');
  assert.equal(c({ downstream: null, releaseAgeSec: 60 }), 'running');
  assert.equal(c({ downstream: ds('success'), inputs: { ...expect, tag: 'trading-core-docs1-dev.32' } }), 'failed');
  assert.equal(c({ downstream: ds('success'), inputs: expect }), 'done');
  const log = `npm run validate:release-tag -- --env dev --binary "trading-core" --tag "trading-core-docs1-dev.33"\n` +
    `npm run validate:ecr-image-provenance -- --env dev --binary "trading-core" --image-digest "${DIGEST}" --git-sha "${SHA1}" --aws-account-id "1"`;
  assert.deepEqual(parseRunInputs(log), expect);
});

// ---------- single architecture writer ----------

test('only the arch:broker fence holder may take or finish an arch request; same pins twice is one row', () => {
  const pins = { 'Equicom-Crypto/edge-api': SHA1, 'Equicom-Crypto/registry': SHA2 };
  const key = C.archKey(['Equicom-Crypto/registry', 'Equicom-Crypto/edge-api'], pins);
  const a = C.archRequest({ as: 'crw', kind: 'drift_audit', key, repos: ['Equicom-Crypto/registry', 'Equicom-Crypto/edge-api'], pins });
  const b = C.archRequest({ as: 'crw', kind: 'drift_audit', key: C.archKey(['Equicom-Crypto/edge-api', 'Equicom-Crypto/registry'], { ...pins }),
    repos: ['Equicom-Crypto/edge-api', 'Equicom-Crypto/registry'], pins: { 'Equicom-Crypto/registry': SHA2, 'Equicom-Crypto/edge-api': SHA1 } });
  assert.equal(b.request.id, a.request.id);
  assert.equal(b.duplicate, true);
  assert.equal(C.archList().requests.length, 1);

  const { fence } = C.claim(C.ARCH_RESOURCE, { as: 'arch-author', ttl: '2h' });
  assert.throws(() => C.archTake(a.request.id, { as: 'cell:x', fence }), e => e.code === 'stale_fence');
  assert.throws(() => C.claim(C.ARCH_RESOURCE, { as: 'cell:x' }), e => e.code === 'held');
  assert.equal(C.archTake(a.request.id, { as: 'arch-author', fence }).request.state, 'taken');
  assert.throws(() => C.archDone(a.request.id, { as: 'arch-author', fence: fence + 1, commits: 'abc' }), e => e.code === 'stale_fence');
  assert.equal(C.archDone(a.request.id, { as: 'arch-author', fence, commits: 'abc,def' }).request.result_commits, '["abc","def"]');
});

// ---------- pause / drain ----------

test('pause refuses claim, admit, start and non-control deliveries; ack still works; gate is non-zero', async () => {
  const r = svc('crw:deploy:6');
  const a = (await C.releaseAdmit(r.id, { as: 'release', verify: ok })).release;
  const { seq } = C.post('delivery', { as: 'crw', kind: 'status', key: 'before', summary: 's' });
  await deliver({ cfg: stub.cfg });
  C.setMode('pause', { as: 'master', reason: 'incident' });
  C.post('delivery', { as: 'crw', kind: 'status', key: 'during', summary: 'held' });
  assert.throws(() => C.claim('ticket:CRP-1', { as: 'cell:a' }), e => e.code === 'paused');
  await refused(() => C.releaseStart(r.id, { as: 'crw', fence: a.fence, verify: ok }), 'paused');
  const r2 = svc('crw:deploy:7', { repo: 'Equicom-Crypto/edge-api', binary: 'edge-api' });
  await refused(() => C.releaseAdmit(r2.id, { as: 'release', verify: ok }), 'paused');


  C.post('delivery', { as: 'crw', kind: 'control', key: 'ctl', summary: 'paused', to: ['master'] });
  const d = await deliver({ cfg: stub.cfg });
  assert.equal(d.sent.length, 1);
  assert.equal(d.held, 1);
  assert.match(stub.sends[1].text, /from crw\] paused/);
  assert.deepEqual(C.ack('master', [seq]).acked, [{ seq }]);

  const g = cli('gate', 'crw');
  assert.equal(g.status, 1);
  assert.equal(g.out.error.code, 'paused');
  C.setMode('run', { as: 'master' });
  assert.equal(cli('gate', 'crw').status, 0);
  assert.equal((await deliver({ cfg: stub.cfg })).sent.length, 1, 'held delivery goes out after resume');
});

test('scoped pause only gates that scope', () => {
  C.setMode('pause', { scope: 'crw', as: 'master', reason: 'r' });
  assert.equal(C.gate('crw').ok, false);
  assert.equal(C.gate('env:dev').ok, true);
  C.claim('env:dev', { as: 'release' });
});

test('drain refuses admit and new claims while a running release can still renew and observe to done', async () => {
  const r = svc('crw:deploy:8');
  const a = (await C.releaseAdmit(r.id, { as: 'release', verify: ok })).release;
  await C.releaseStart(r.id, { as: 'crw', fence: a.fence, verify: ok });
  const c = C.claim('pr:y#2', { as: 'cell:a' });
  C.setMode('drain', { scope: 'env:dev', as: 'master', reason: 'baseline' });
  const r2 = svc('crw:deploy:9', { repo: 'Equicom-Crypto/edge-api', binary: 'edge-api' });
  await refused(() => C.releaseAdmit(r2.id, { as: 'release', verify: ok }), 'draining');
  assert.throws(() => C.claim('env:dev', { as: 'release' }), e => e.code === 'draining');
  C.renew('pr:y#2', { as: 'cell:a', fence: c.fence });
  const rep = await C.drainReport({ threadState: id => threadState(stub.cfg, id) });
  assert.equal(rep.drained, false);
  assert.equal(rep.inflight.releases[0].id, r.id);
  const done = await C.releaseObserve(r.id, { observe: async () => ({ state: 'done', readback: { digest: DIGEST } }) });
  assert.equal(done.release.state, 'done');
  assert.equal(cli('gate', 'env:dev').out.error.code, 'draining');
});

// ---------- child completion ----------

test('child completion: delivered once with mode queue behind a running turn, acked once, never resent', async () => {
  C.actorSet('parent', { thread: 'T-parent' });
  C.actorSet('child', { kind: 'process' });
  C.channelCreate('cell:registry', { owner: 'parent' });
  const { seq } = C.post('cell:registry', { as: 'child', kind: 'status', key: 'child:done:1', summary: 'done', to: ['parent'], body: { result: 'ok' } });
  const d = await deliver({ cfg: stub.cfg });
  assert.deepEqual(d.sent.map(s => s.delivery), ['queued']);
  assert.equal(stub.sends[0].mode, 'queue');
  assert.equal((await deliver({ cfg: stub.cfg })).sent.length, 0);
  C.ack('parent', [seq]);
  C.ack('parent', [seq]);
  advance(100000);
  const later = await deliver({ cfg: stub.cfg });
  assert.equal(later.sent.length + later.reminded.length, 0);
  assert.equal(stub.sends.length, 1);
});

test('unacked delivery gets exactly one reminder, then attention', async () => {
  C.post('delivery', { as: 'crw', kind: 'request', key: 'r1', summary: 'x' });
  await deliver({ cfg: stub.cfg });
  advance(C.DEFAULTS.unackedAfter + 1);
  assert.equal((await deliver({ cfg: stub.cfg })).reminded.length, 1);
  advance(C.DEFAULTS.unackedAfter + 1);
  assert.equal((await deliver({ cfg: stub.cfg })).reminded.length, 0);
  assert.equal(stub.sends.length, 2);
  assert.equal(C.attention().unacked.filter(u => u.recipient === 'master').length, 1);
});

test('actor rebind retargets pending deliveries to the new thread', async () => {
  stub.failNext(1);
  C.post('delivery', { as: 'crw', kind: 'request', key: 'h1', summary: 'handoff me' });
  assert.equal((await deliver({ cfg: stub.cfg })).retry.length, 1);
  const r = C.actorSet('master', { thread: 'T-new' });
  assert.equal(r.retargeted, 1);
  const d = await deliver({ cfg: stub.cfg });
  assert.equal(d.sent.length, 1);
  assert.equal(stub.sends.at(-1).thread, 'T-new');
  assert.equal(stub.messages['T-master'], undefined);
});

test('a thread in Robob waiting is not treated as drained', async () => {
  assert.equal(C.threadDrained('waiting'), false);
  assert.equal(C.threadDrained('idle'), true);
  stub.states['T-master'] = 'waiting';
  const rep = await C.drainReport({ threadState: id => threadState(stub.cfg, id) });
  assert.equal(rep.drained, false);
  assert.deepEqual(rep.inflight.threads, [{ actor: 'master', thread: 'T-master', state: 'waiting' }]);
  stub.states['T-master'] = 'idle';
  assert.equal((await C.drainReport({ threadState: id => threadState(stub.cfg, id) })).drained, true);
});

// ---------- approval provenance ----------

test('approval provenance: only createdBy=user from web or mobile binds', () => {
  const m = (createdBy, creationSource, text = 'Approved', role = 'user') => ({ messageId: 'm', role, text, createdBy, creationSource });
  assert.equal(C.approvalProvenance(m('user', 'web')).verified, true);
  assert.equal(C.approvalProvenance(m('user', 'mobile')).verified, true);
  for (const x of [m('user', 'server'), m('agent', 'mcp'), m('user', 'provider'), m('agent', 'provider'), m(undefined, undefined),
    m('user', 'web', 'Approved', 'assistant'), m('user', 'web', '[coord delivery #3 from crw] Approved'), m('user', 'web', '[crw] Approved')])
    assert.equal(C.approvalProvenance(x).verified, false, JSON.stringify(x));
  assert.equal(C.approvalProvenance(m('user', 'server'), { sources: ['web', 'mobile', 'server'] }).verified, true);
});

// ---------- dependencies ----------

test('deps: event_acked, claim_free and manual readiness', async () => {
  C.depAdd('w1', 'event_acked', 'e1');
  C.depAdd('w1', 'claim_free', 'env:dev');
  const m = C.depAdd('w1', 'manual', 'owner ok').dep;
  assert.equal((await C.ready('w1')).ready, false);
  const { seq } = C.post('delivery', { as: 'master', kind: 'request', key: 'e1', summary: 'x' });
  C.ack('crw', [seq]);
  C.depSet(m.id, { state: 'ready', evidence: 'owner said so' });
  assert.equal((await C.ready('w1')).ready, true);
  C.claim('env:dev', { as: 'release' });
  assert.equal((await C.ready('w1')).deps.find(d => d.need === 'claim_free').state, 'waiting');
});

// ---------- CLI ----------

test('CLI: JSON output, refusal exits 1 with error.code', () => {
  C.close();
  assert.equal(cli('post', 'delivery', '--as', 'crw', '--kind', 'status', '--key', 'c1', '--summary', 'one', '--no-deliver').status, 0);
  const dup = cli('post', 'delivery', '--as', 'crw', '--kind', 'status', '--key', 'c1', '--summary', 'two', '--no-deliver');
  assert.equal(dup.status, 1);
  assert.equal(dup.out.error.code, 'conflict');
  const c = cli('claim', 'ticket:CRP-9', '--as', 'cell:a', '--ttl', '10m');
  assert.equal(c.out.fence, 1);
  assert.equal(cli('check', 'ticket:CRP-9', '--as', 'cell:a', '--fence', '1').status, 0);
  assert.equal(cli('check', 'ticket:CRP-9', '--as', 'cell:b', '--fence', '1').out.error.code, 'stale_fence');
  assert.equal(cli('bogus').status, 2);
  assert.equal(cli('init').out.actors[0].actor.id, 'crw');
  assert.equal(cli('tf', 'gen', 'dev').out.gen, 0);
  const tf = cli('release', 'request', '--as', 'release', '--key', 'tfc', '--kind', 'tf_apply', '--env', 'dev', '--plan', 'saved:1@1');
  assert.equal(tf.status, 0, JSON.stringify(tf.out));
  assert.deepEqual(tf.out.release.footprint, ['env:dev', 'tf:dev']);
  const empty = cli('release', 'request', '--as', 'crw', '--key', 'svc0', '--kind', 'service_release', '--env', 'dev', '--repo', 'Equicom-Crypto/Reporting', '--binary', 'reporting',
    '--sha', SHA1, '--tag', 'reporting-docs1-dev.1', '--runtime-sha', SHA1, '--content-prs', '');
  assert.equal(empty.status, 0, JSON.stringify(empty.out));
  assert.deepEqual([empty.out.release.content_prs, empty.out.release.repo], [[], 'equicom-crypto/reporting']);
  assert.equal(cli('flag', 'tf_full_root_blocked', 'off', '--as', 'release').out.error.code, 'forbidden');
});

test('evidence: verifyHead and serviceRuntime read gh output (fake gh)', async () => {
  const { verifyHead, serviceRuntime } = await import('../lib/evidence.mjs');
  const rel = { repo: 'Equicom-Crypto/trading-core', git_sha: SHA1 };
  const compare = status => async () => JSON.stringify({ status });
  assert.equal((await verifyHead(rel, { gh: compare('behind') })).ok, true);
  assert.equal((await verifyHead(rel, { gh: compare('identical') })).ok, true);
  for (const st of ['ahead', 'diverged']) {
    const div = await verifyHead(rel, { gh: compare(st) });
    assert.deepEqual([div.ok, div.transient], [false, undefined], st);
  }
  const gone = await verifyHead(rel, { gh: async () => { throw new Error('gh: No commit found for SHA'); } });
  assert.deepEqual([gone.ok, gone.transient], [false, undefined]);
  const net = await verifyHead(rel, { gh: async () => { throw new Error('connection reset'); } });
  assert.deepEqual([net.ok, net.transient], [false, true]);
  const r = svc('v1');
  await refused(() => C.releaseAdmit(r.id, { as: 'release', verify: () => verifyHead(r, { gh: async () => { throw new Error('timeout'); } }) }), 'verify_failed');
  assert.equal(C.releaseList({ state: 'requested' }).releases.length, 1, 'a transient failure does not supersede');

  const gh = deployGh({ 'deploy-dev-service.yml': [
    { id: 10, started: '2026-10-01T00:00:00Z', log: deployLog('trading-core', 'trading-core-docs1-dev.32', SHA1) },
    { id: 11, started: '2026-10-02T00:00:00Z', log: deployLog('risk-liquidation', 'dev.34', SHA2) }] });
  const rt = await serviceRuntime({ binary: 'trading-core', gh });
  assert.deepEqual(rt, { state: 'known', sha: SHA1, tag: 'trading-core-docs1-dev.32', digest: DIGEST, run: '10', attempt: 1, reason: null });
  const logs = gh.calls.filter(c => c.includes('/logs')).length;
  await serviceRuntime({ binary: 'trading-core', gh });
  assert.equal(gh.calls.filter(c => c.includes('/logs')).length, logs, 'run inputs are cached per run attempt');
});

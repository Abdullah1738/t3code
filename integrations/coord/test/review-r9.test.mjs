// Regression tests for review r9 of 051b4adca0 (R9-<N> in the test name).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../lib/coord.mjs';
import * as E from '../lib/evidence.mjs';
import { fresh, stubControl, SHA0, SHA1, SHA2, fakeGh, deployLog, resetHooks, tagFor } from './helpers.mjs';

const TC = 'equicom-crypto/trading-core';
const DEVOPS = 'equicom-crypto/crpko-devops';
const ok = async () => ({ ok: true });
const refused = (fn, code) => assert.rejects(async () => fn(), e => { assert.equal(e.code, code, `${e.code}: ${e.message}`); return true; });

let stub;
beforeEach(async () => {
  fresh();
  resetHooks();
  stub = await stubControl({ states: {} });
});
afterEach(async () => { await stub.close(); C.close(); });

// ---------- R9-1 ----------

const A = SHA1, B = SHA2;
const VALIDATED = [{ name: 'Install Terraform', conclusion: 'success' }, { name: 'Validate release tag', conclusion: 'success' }];
const EARLY_FAIL = [{ name: 'Install Terraform', conclusion: 'failure' }, { name: 'Validate release tag', conclusion: 'skipped' }];

// GitHub for deploy-dev-service runs with several attempts each. runs: { id: { created, attempts: [{ started,
// conclusion, steps, log }] } }; the run list shows each run at its latest attempt.
function runsGh(runs, { repo = DEVOPS, workflow = 'deploy-dev-service.yml', head = {} } = {}) {
  const meta = (id, k) => {
    const r = runs[id], a = r.attempts[k - 1];
    return { id: Number(id), path: `.github/workflows/${workflow}`, status: a.status ?? 'completed', conclusion: a.conclusion, run_attempt: k,
      created_at: r.created, run_started_at: a.started, head_sha: a.head ?? head[id], head_branch: 'main-dev' };
  };
  const latest = id => runs[id].attempts.length;
  return fakeGh([
    [new RegExp(`repos/${repo}/actions/workflows/[\\w.-]+/runs\\?`), m => ({
      workflow_runs: m.input.includes(workflow) ? Object.keys(runs).map(id => meta(id, latest(id))) : [] })],
    [/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs/, m => {
      const a = runs[m[1]].attempts[m[2] - 1];
      return { total_count: 1, jobs: [{ id: Number(m[1]) * 10 + Number(m[2]), name: a.job ?? 'deploy', status: 'completed', conclusion: a.jobConclusion ?? a.conclusion,
        run_attempt: Number(m[2]), steps: a.steps }] };
    }],
    [/actions\/runs\/(\d+)\/attempts\/(\d+)$/, m => meta(m[1], Number(m[2]))],
    [/actions\/jobs\/(\d+)\/logs/, m => runs[Math.floor(m[1] / 10)].attempts[(m[1] % 10) - 1].log ?? ''],
    [/actions\/runs\/(\d+)$/, m => meta(m[1], latest(m[1]))],
  ]);
}
const tcDeploy = (sha, started, o = {}) => ({ started, conclusion: 'success', steps: VALIDATED, log: deployLog('trading-core', tagFor('trading-core', o.n ?? 1), sha), ...o });
const noOp = started => ({ started, conclusion: 'failure', steps: EARLY_FAIL, log: 'terraform download failed' });

test('R9-1 a rerun that fails before validation does not hide the earlier deployment of that run', async () => {
  const gh = runsGh({
    10: { created: '2026-10-01T00:00:00Z', attempts: [tcDeploy(A, '2026-10-01T00:00:00Z', { n: 1 })] },
    20: { created: '2026-10-02T00:00:00Z', attempts: [tcDeploy(B, '2026-10-02T00:00:00Z', { n: 2 }), noOp('2026-10-03T00:00:00Z')] },
  });
  const rt = await E.serviceRuntime({ binary: 'trading-core', gh });
  assert.notEqual(rt.sha, A, 'never the older run');
  assert.deepEqual([rt.state, rt.sha, rt.run, rt.attempt], ['known', B, '20', 1]);
  assert.ok(gh.calls.some(c => c.includes('runs/20/attempts/1/jobs')), 'the earlier attempt was read');
});

test('guard for R9-1: the earlier attempt keeps its own place in time: a later run still wins over it', async () => {
  const gh = runsGh({
    20: { created: '2026-10-01T00:00:00Z', attempts: [tcDeploy(B, '2026-10-01T00:00:00Z', { n: 2 }), noOp('2026-10-05T00:00:00Z')] },
    30: { created: '2026-10-03T00:00:00Z', attempts: [tcDeploy(A, '2026-10-03T00:00:00Z', { n: 3 })] },
  });
  const rt = await E.serviceRuntime({ binary: 'trading-core', gh });
  assert.deepEqual([rt.state, rt.sha, rt.run], ['known', A, '30']);
});

test('guard for R9-1: a rerun whose effect cannot be determined makes runtime unknown, never an older run', async () => {
  const gh = runsGh({
    10: { created: '2026-10-01T00:00:00Z', attempts: [tcDeploy(A, '2026-10-01T00:00:00Z', { n: 1 })] },
    20: { created: '2026-10-02T00:00:00Z', attempts: [tcDeploy(B, '2026-10-02T00:00:00Z', { n: 2 }),
      { started: '2026-10-03T00:00:00Z', conclusion: 'failure', steps: [{ name: 'Validate release tag', conclusion: 'failure' }], log: 'validation output lost' }] },
  });
  const rt = await E.serviceRuntime({ binary: 'trading-core', gh });
  assert.equal(rt.state, 'unknown');
  assert.equal(rt.sha, null);
});

test('R9-1 an A-only dependency is not ready and an A..A release is not admitted when B is live', async () => {
  const gh = runsGh({
    10: { created: '2026-10-01T00:00:00Z', attempts: [tcDeploy(A, '2026-10-01T00:00:00Z', { n: 1 })] },
    20: { created: '2026-10-02T00:00:00Z', attempts: [tcDeploy(B, '2026-10-02T00:00:00Z', { n: 2 }), noOp('2026-10-03T00:00:00Z')] },
  });
  const rt = await E.serviceRuntime({ binary: 'trading-core', gh });
  C.configure({ runtime: async () => rt });
  const r = C.releaseRequest({ as: 'crw', key: 'aa', kind: 'service_release', env: 'dev', repo: TC, binary: 'trading-core',
    sha: A, runtimeSha: A, contentPrs: [], tag: tagFor('trading-core', 5) }).release;
  C.configure({ rangeResolver: async () => ({ complete: true, prs: [] }) });
  await refused(() => C.releaseAdmit(r.id, { as: 'crw', verify: ok }), 'runtime_moved');
});

test('R9-1 frontend runtime: an attempt that ran no deploy job does not hide the earlier deploy of that run', async () => {
  const FE = 'equicom-crypto/crypko-frontend';
  const ran = (head, started) => ({ started, conclusion: 'success', job: 'Deploy to Dev', head, steps: [{ name: 'Deploy with SST', conclusion: 'success' }] });
  const authOnly = (head, started) => ({ started, conclusion: 'failure', job: 'Authorize manual run', jobConclusion: 'failure', head, steps: [] });
  const gh = runsGh({
    5: { created: '2026-10-01T00:00:00Z', attempts: [ran(A, '2026-10-01T00:00:00Z')] },
    6: { created: '2026-10-02T00:00:00Z', attempts: [ran(B, '2026-10-02T00:00:00Z'), authOnly(B, '2026-10-03T00:00:00Z')] },
  }, { repo: FE, workflow: 'deploy-dev.yml' });
  const rt = await E.frontendRuntime({ repo: FE, gh });
  assert.deepEqual([rt.state, rt.sha, rt.run, rt.attempt], ['known', B, '6', 1]);
});

// ---------- R9-2 ----------

test('R9-2 release start compares a restated env, repo and sha in canonical form', async () => {
  C.configure({ rangeResolver: async () => ({ complete: true, prs: [] }) });
  const req = (key, o = {}) => C.releaseRequest({ as: 'crw', key, kind: 'service_release', env: 'DEV', repo: 'Equicom-Crypto/trading-core', binary: 'trading-core',
    sha: SHA1, runtimeSha: SHA0, contentPrs: [], tag: tagFor(), ...o }).release;
  const r = req('mixed');
  assert.equal(r.environment, 'dev');
  const a = (await C.releaseAdmit(r.id, { as: 'crw', verify: ok })).release;
  const s = (await C.releaseStart(a.id, { as: 'crw', fence: a.fence, env: 'DEV', repo: 'EQUICOM-CRYPTO/Trading-Core', sha: SHA1.toUpperCase(), verify: ok })).release;
  assert.deepEqual([s.state, s.environment], ['running', 'dev']);
  // Genuinely different or malformed restatements are still refused.
  await C.releaseReconcile(s.id, { as: 'release', outcome: 'done', evidence: 'deploy run 1 attempt 1 ok' });
  const b = (await C.releaseAdmit(req('other', { tag: tagFor('trading-core', 34) }).id, { as: 'crw', verify: ok })).release;
  await refused(() => C.releaseStart(b.id, { as: 'crw', fence: b.fence, env: 'prod', verify: ok }), 'binding_mismatch');
  await refused(() => C.releaseStart(b.id, { as: 'crw', fence: b.fence, env: 'de v', verify: ok }), 'env_invalid');
  await refused(() => C.releaseStart(b.id, { as: 'crw', fence: b.fence, repo: 'equicom-crypto/edge-api', verify: ok }), 'binding_mismatch');
});

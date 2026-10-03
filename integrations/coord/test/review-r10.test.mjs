// Regression tests for review r10 of 4971d0e9f5 (R10-<N> in the test name).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../lib/coord.mjs';
import * as E from '../lib/evidence.mjs';
import { fresh, stubControl, SHA1, SHA2, fakeGh, deployLog, resetHooks, tagFor } from './helpers.mjs';

const TC = 'equicom-crypto/trading-core';
const FE = 'equicom-crypto/crypko-frontend';
const DEVOPS = 'equicom-crypto/crpko-devops';
const ok = async () => ({ ok: true });
const refused = (fn, code) => assert.rejects(async () => fn(), e => { assert.equal(e.code, code, `${e.code}: ${e.message}`); return true; });
const A = SHA1, B = SHA2;

let stub;
beforeEach(async () => {
  fresh();
  resetHooks();
  stub = await stubControl({ states: {} });
});
afterEach(async () => { await stub.close(); C.close(); });

// Runs with several attempts. The run list and /runs/<id> show each run at its latest attempt; `move(id, attempt)`
// appends an attempt while discovery is running. `trigger` names the attempt whose jobs read fires `onRead` once.
function world({ repo, workflow, runs }) {
  const w = { runs, onRead: null, reads: [], fail: new Set() };
  const meta = (id, k) => {
    const r = w.runs[id], a = r.attempts[k - 1];
    return { id: Number(id), path: `.github/workflows/${workflow}`, status: a.status ?? 'completed', conclusion: a.conclusion ?? null, run_attempt: k,
      created_at: r.created, run_started_at: a.started, head_sha: a.head, head_branch: 'main-dev' };
  };
  const latest = id => w.runs[id].attempts.length;
  w.gh = fakeGh([
    [new RegExp(`repos/${repo}/actions/workflows/[\\w.-]+/runs\\?`), () => ({ workflow_runs: Object.keys(w.runs).map(id => meta(id, latest(id))) })],
    [/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs/, m => {
      const a = w.runs[m[1]].attempts[m[2] - 1];
      if (w.onRead && w.onRead.on === `${m[1]}/${m[2]}`) { const f = w.onRead.fn; w.onRead = null; f(); }
      return { total_count: 1, jobs: [{ id: Number(m[1]) * 10 + Number(m[2]), name: a.job ?? 'deploy', status: 'completed',
        conclusion: a.jobConclusion ?? a.conclusion, run_attempt: Number(m[2]), steps: a.steps ?? [] }] };
    }],
    [/actions\/runs\/(\d+)\/attempts\/(\d+)$/, m => meta(m[1], Number(m[2]))],
    [/actions\/jobs\/(\d+)\/logs/, m => w.runs[Math.floor(m[1] / 10)].attempts[(m[1] % 10) - 1].log ?? ''],
    [/actions\/runs\/(\d+)$/, m => { w.reads.push(m[1]); if (w.fail.has(m[1])) throw new Error('HTTP 502'); return meta(m[1], latest(m[1])); }],
  ]);
  return w;
}

const VALIDATED = [{ name: 'Install Terraform', conclusion: 'success' }, { name: 'Validate release tag', conclusion: 'success' }];
const EARLY_FAIL = [{ name: 'Install Terraform', conclusion: 'failure' }, { name: 'Validate release tag', conclusion: 'skipped' }];
const deploy = (sha, started, n) => ({ started, conclusion: 'success', steps: VALIDATED, log: deployLog('trading-core', tagFor('trading-core', n), sha) });
const noOp = started => ({ started, conclusion: 'failure', steps: EARLY_FAIL, log: 'terraform download failed' });
const rerunning = started => ({ started, status: 'in_progress', conclusion: null, steps: [] });

// run 20 deployed B (Oct 1), run 30 deployed A (Oct 2), run 20 rerun as a no-op (Oct 3): runtime is A.
const serviceWorld = () => world({ repo: DEVOPS, workflow: 'deploy-dev-service.yml', runs: {
  20: { created: '2026-10-01T00:00:00Z', attempts: [deploy(B, '2026-10-01T00:00:00Z', 2), noOp('2026-10-03T00:00:00Z')] },
  30: { created: '2026-10-02T00:00:00Z', attempts: [deploy(A, '2026-10-02T00:00:00Z', 3)] },
} });

test('guard for R10-1: with nothing moving, the demoted run stays behind the later run', async () => {
  const w = serviceWorld();
  const rt = await E.serviceRuntime({ binary: 'trading-core', gh: w.gh });
  assert.deepEqual([rt.state, rt.sha, rt.run], ['known', A, '30']);
  assert.ok(w.reads.includes('20') && w.reads.includes('30'), 'both runs were re-read');
});

test('R10-1 service: a demoted run that starts a new attempt while the winner is read makes runtime unknown', async () => {
  const w = serviceWorld();
  w.onRead = { on: '30/1', fn: () => w.runs[20].attempts.push(rerunning('2026-10-04T00:00:00Z')) };
  const rt = await E.serviceRuntime({ binary: 'trading-core', gh: w.gh });
  assert.equal(rt.state, 'unknown');
  assert.match(rt.reason, /run 20/);
});

test('R10-1 service: a demoted run that completes a new deploy while the winner is read makes runtime unknown', async () => {
  const w = serviceWorld();
  w.onRead = { on: '30/1', fn: () => w.runs[20].attempts.push(deploy(B, '2026-10-04T00:00:00Z', 2)) };
  const rt = await E.serviceRuntime({ binary: 'trading-core', gh: w.gh });
  assert.notEqual(rt.sha, A);
  assert.equal(rt.state, 'unknown');
});

test('R10-1 service: a run skipped entirely as a no-op that advances makes runtime unknown', async () => {
  const w = world({ repo: DEVOPS, workflow: 'deploy-dev-service.yml', runs: {
    30: { created: '2026-10-02T00:00:00Z', attempts: [deploy(A, '2026-10-02T00:00:00Z', 3)] },
    40: { created: '2026-10-03T00:00:00Z', attempts: [noOp('2026-10-03T00:00:00Z')] },
  } });
  w.onRead = { on: '30/1', fn: () => w.runs[40].attempts.push(rerunning('2026-10-04T00:00:00Z')) };
  const rt = await E.serviceRuntime({ binary: 'trading-core', gh: w.gh });
  assert.equal(rt.state, 'unknown');
  assert.match(rt.reason, /run 40/);
});

test('R10-1 service: a considered run that cannot be re-read makes runtime unknown', async () => {
  const w = serviceWorld();
  w.fail.add('20');
  const rt = await E.serviceRuntime({ binary: 'trading-core', gh: w.gh });
  assert.equal(rt.state, 'unknown');
  assert.match(rt.reason, /run 20 could not be re-read/);
});

// Frontend: run 20 deployed B, run 30 deployed A, run 20 rerun cancelled before any job (zero jobs).
const ran = (head, started) => ({ started, conclusion: 'success', job: 'Deploy to Dev', head, steps: [{ name: 'Deploy with SST', conclusion: 'success' }] });
const cancelledNoJobs = (head, started) => ({ started, conclusion: 'cancelled', job: 'Deploy to Dev', jobConclusion: 'skipped', head });
const frontendWorld = () => world({ repo: FE, workflow: 'deploy-dev.yml', runs: {
  20: { created: '2026-10-01T00:00:00Z', attempts: [ran(B, '2026-10-01T00:00:00Z'), cancelledNoJobs(B, '2026-10-03T00:00:00Z')] },
  30: { created: '2026-10-02T00:00:00Z', attempts: [ran(A, '2026-10-02T00:00:00Z')] },
} });

test('R10-1 frontend: a demoted run that redeploys while the winner is read makes runtime unknown', async () => {
  const w = frontendWorld();
  assert.deepEqual([(await E.frontendRuntime({ repo: FE, gh: w.gh })).sha], [A], 'stable case is A');
  C.close(); fresh(); resetHooks();
  const w2 = frontendWorld();
  w2.onRead = { on: '30/1', fn: () => w2.runs[20].attempts.push(ran(B, '2026-10-04T00:00:00Z')) };
  const rt = await E.frontendRuntime({ repo: FE, gh: w2.gh });
  assert.equal(rt.state, 'unknown');
  assert.match(rt.reason, /run 20/);
});

test('R10-1 frontend: a considered run that cannot be re-read makes runtime unknown', async () => {
  const w = frontendWorld();
  w.fail.add('20');
  assert.equal((await E.frontendRuntime({ repo: FE, gh: w.gh })).state, 'unknown');
});

test('R10-1 an A-only pr_deployed dependency stays waiting and an A..A release is refused when the demoted run moved', async () => {
  const w = serviceWorld();
  const prGh = fakeGh([
    [/pr view 7/, { state: 'MERGED', mergeCommit: { oid: A } }],
    [/compare\//, { status: 'identical' }],
    [/.*/, async m => w.gh(m.input.split(' '))],
  ]);
  w.onRead = { on: '30/1', fn: () => w.runs[20].attempts.push(deploy(B, '2026-10-04T00:00:00Z', 2)) };
  const dep = await E.external({ need: 'pr_deployed', ref: `${TC}#7` }, { gh: prGh });
  assert.equal(dep.state, 'waiting');
  C.close(); fresh(); resetHooks();
  const w2 = serviceWorld();
  w2.onRead = { on: '30/1', fn: () => w2.runs[20].attempts.push(deploy(B, '2026-10-04T00:00:00Z', 2)) };
  C.configure({ runtime: r => E.serviceRuntime({ binary: r.binary, gh: w2.gh }), rangeResolver: async () => ({ complete: true, prs: [] }) });
  const r = C.releaseRequest({ as: 'crw', key: 'aa', kind: 'service_release', env: 'dev', repo: TC, binary: 'trading-core',
    sha: A, runtimeSha: A, contentPrs: [], tag: tagFor('trading-core', 5) }).release;
  await refused(() => C.releaseAdmit(r.id, { as: 'crw', verify: ok }), 'runtime_unknown');
});

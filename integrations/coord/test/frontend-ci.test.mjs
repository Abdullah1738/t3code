// crypko-frontend also deploys dev from its CI workflow (ci.yml, job 'Deploy to Dev' on a push to main-dev).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../lib/coord.mjs';
import * as E from '../lib/evidence.mjs';
import { fresh, SHA0, SHA1, SHA2, fakeGh, resetHooks } from './helpers.mjs';

const FE = 'equicom-crypto/crypko-frontend';
const BO = 'equicom-crypto/backoffice-frontend';
const A = SHA1, B = SHA2;

beforeEach(() => { fresh(); resetHooks(); });
afterEach(() => C.close());

// runs: [{ id, wf, head, started, ended, event?, branch?, conclusion?, jobs: [{ name, conclusion, steps? }] }]
function feGh(runs, { repo = FE, extra = [] } = {}) {
  const meta = r => ({ id: r.id, path: `.github/workflows/${r.wf}`, event: r.event ?? (r.wf === 'ci.yml' ? 'push' : 'workflow_dispatch'),
    status: r.status ?? 'completed', conclusion: r.conclusion ?? 'success', run_attempt: 1, created_at: r.started, run_started_at: r.started,
    updated_at: r.ended, head_sha: r.head, head_branch: r.branch ?? 'main-dev', html_url: `https://github.com/${repo}/actions/runs/${r.id}` });
  const byId = id => runs.find(r => r.id === Number(id));
  return fakeGh([
    ...extra,
    [new RegExp(`repos/${repo}/actions/workflows/([\\w.-]+)/runs\\?`), m => ({ workflow_runs: runs.filter(r => r.wf === m[1]).map(meta) })],
    [/actions\/runs\/(\d+)\/attempts\/1\/jobs/, m => ({ jobs: byId(m[1]).jobs.map((j, i) => ({ id: Number(m[1]) * 10 + i, status: 'completed', run_attempt: 1,
      steps: j.conclusion === 'skipped' ? [] : [{ name: 'Deploy with SST', conclusion: j.conclusion }], ...j })) })],
    [/actions\/runs\/(\d+)$/, m => meta(byId(m[1]))],
  ]);
}
const CI_JOBS = deploy => [{ name: 'Authorize manual run', conclusion: 'skipped' }, { name: 'Tests', conclusion: 'success' },
  { name: 'Build Check', conclusion: 'success' }, { name: 'Deploy to Dev', conclusion: deploy }];
const DD_JOBS = [{ name: 'Authorize manual run', conclusion: 'skipped' }, { name: 'Deploy to Dev', conclusion: 'success' }];
const ciRun = (id, head, started, ended, deploy = 'success', o = {}) => ({ id, wf: 'ci.yml', head, started, ended, jobs: CI_JOBS(deploy), ...o });
const ddRun = (id, head, started, ended, o = {}) => ({ id, wf: 'deploy-dev.yml', head, started, ended, jobs: DD_JOBS, ...o });

test('a CI push run whose Deploy to Dev job succeeded is the frontend runtime', async () => {
  const gh = feGh([
    ddRun(10, A, '2026-10-08T19:28:55Z', '2026-10-08T19:37:31Z'),
    ciRun(20, B, '2026-10-10T07:45:04Z', '2026-10-10T08:16:58Z'),
  ]);
  const rt = await E.frontendRuntime({ repo: FE, gh });
  assert.deepEqual([rt.state, rt.sha, rt.run, rt.attempt], ['known', B, '20', 1]);
  assert.ok(gh.calls.some(c => c.includes('workflows/ci.yml/runs?per_page=100&page=1&event=push&branch=main-dev')), 'CI list is filtered to pushes on the deploy branch');
});

test('a CI run whose Deploy to Dev job was skipped does not count', async () => {
  const gh = feGh([
    ddRun(10, A, '2026-10-08T19:28:55Z', '2026-10-08T19:37:31Z'),
    ciRun(20, B, '2026-10-10T07:45:04Z', '2026-10-10T08:00:00Z', 'skipped', { conclusion: 'failure' }),
  ]);
  const rt = await E.frontendRuntime({ repo: FE, gh });
  assert.deepEqual([rt.state, rt.sha, rt.run], ['known', A, '10']);
});

test('a CI run whose Deploy to Dev job failed after starting leaves the runtime unknown', async () => {
  const gh = feGh([
    ddRun(10, A, '2026-10-08T19:28:55Z', '2026-10-08T19:37:31Z'),
    ciRun(20, B, '2026-10-10T07:45:04Z', '2026-10-10T08:16:58Z', 'failure', { conclusion: 'failure' }),
  ]);
  const rt = await E.frontendRuntime({ repo: FE, gh });
  assert.equal(rt.state, 'unknown');
  assert.equal(rt.sha, null);
  assert.match(rt.reason, /CI run 20/);
});

test('a CI run that is not a push to main-dev never counts, even with a Deploy to Dev job', async () => {
  for (const o of [{ event: 'pull_request' }, { event: 'workflow_dispatch' }, { branch: 'fix/x' }]) {
    C.close(); fresh(); resetHooks();
    const gh = feGh([
      ddRun(10, A, '2026-10-08T19:28:55Z', '2026-10-08T19:37:31Z'),
      ciRun(20, B, '2026-10-10T07:45:04Z', '2026-10-10T08:16:58Z', 'success', o),
    ]);
    const rt = await E.frontendRuntime({ repo: FE, gh });
    assert.deepEqual([rt.state, rt.sha, rt.run], ['known', A, '10'], JSON.stringify(o));
  }
});

test('the deploy that finished last wins between deploy-dev.yml and ci.yml', async () => {
  // CI started first but its deploy finished after the manual deploy: CI is live.
  let rt = await E.frontendRuntime({ repo: FE, gh: feGh([
    ciRun(20, B, '2026-10-10T07:45:04Z', '2026-10-10T08:16:58Z'),
    ddRun(10, A, '2026-10-10T07:50:00Z', '2026-10-10T07:58:00Z'),
  ]) });
  assert.deepEqual([rt.state, rt.sha, rt.run], ['known', B, '20']);
  C.close(); fresh(); resetHooks();
  // A manual deploy that finished after the CI deploy is live.
  rt = await E.frontendRuntime({ repo: FE, gh: feGh([
    ciRun(20, B, '2026-10-10T07:45:04Z', '2026-10-10T08:16:58Z'),
    ddRun(10, A, '2026-10-10T08:10:00Z', '2026-10-10T08:20:00Z'),
  ]) });
  assert.deepEqual([rt.state, rt.sha, rt.run], ['known', A, '10']);
});

test('a CI push run still running makes the runtime unknown', async () => {
  const rt = await E.frontendRuntime({ repo: FE, gh: feGh([
    ddRun(10, A, '2026-10-08T19:28:55Z', '2026-10-08T19:37:31Z'),
    ciRun(20, B, '2026-10-10T07:45:04Z', '2026-10-10T07:50:00Z', 'success', { status: 'in_progress', conclusion: null }),
  ]) });
  assert.equal(rt.state, 'unknown');
  assert.match(rt.reason, /run 20 is in_progress/);
});

test('backoffice-frontend reads only deploy-dev.yml', async () => {
  const gh = feGh([ddRun(10, A, '2026-10-08T19:28:55Z', '2026-10-08T19:37:31Z'), ciRun(20, B, '2026-10-10T07:45:04Z', '2026-10-10T08:16:58Z')], { repo: BO });
  const rt = await E.frontendRuntime({ repo: BO, gh });
  assert.deepEqual([rt.state, rt.sha, rt.run], ['known', A, '10']);
  assert.ok(!gh.calls.some(c => c.includes('ci.yml')));
});

test('a frontend release observed through a CI run is done only when its Deploy to Dev job succeeded', async () => {
  const rel = (key, run) => ({ ...C.releaseRequest({ as: 'crw', key, kind: 'frontend_release', env: 'dev', repo: FE, binary: 'crypko-frontend',
    sha: B, runtimeSha: SHA0, contentPrs: [`${FE}#9`] }).release, deploy_run: String(run) });
  const compare = [[/compare\//, { status: 'identical' }]];
  const ok = await E.observeRelease(rel('ci-ok', 20), { gh: feGh([ciRun(20, B, '2026-10-10T07:45:04Z', '2026-10-10T08:16:58Z')], { extra: compare }) });
  assert.equal(ok.state, 'done');
  assert.equal(ok.readback.observed_head, B);
  const skipped = await E.observeRelease(rel('ci-skip', 21), { gh: feGh([ciRun(21, B, '2026-10-10T07:45:04Z', '2026-10-10T08:00:00Z', 'skipped')], { extra: compare }) });
  assert.equal(skipped.state, 'unknown');
  const pr = await E.observeRelease(rel('ci-pr', 22), { gh: feGh([ciRun(22, B, '2026-10-10T07:45:04Z', '2026-10-10T08:16:58Z', 'success', { event: 'pull_request' })], { extra: compare }) });
  assert.equal(pr.state, 'unknown');
});

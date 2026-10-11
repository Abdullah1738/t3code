// Revision-specific deploy evidence from GitHub. Read-only: it only runs `gh` queries.
// Everything here fails closed: anything it cannot positively identify is `unknown`, never older evidence.
// Terraform, DDL and migrations are not classified here; they are closed by hand (coord release reconcile).
import { execFile } from 'node:child_process';
import { get, run, CoordError } from './db.mjs';

export const DEVOPS = 'equicom-crypto/crpko-devops';
export const BRANCH = process.env.COORD_DEPLOY_BRANCH || 'main-dev';
export const SUPPORTED_ENVS = ['dev']; // environments with an evidence source; others are refused
// Every workflow that runs deploy-dev-service for a binary (rollback calls it as a reusable workflow).
export const SERVICE_DEPLOY_WORKFLOWS = ['deploy-dev-service.yml', 'rollback-dev-service.yml'];
export const SERVICE_DEPLOY_WORKFLOW = 'deploy-dev-service.yml';
// Service repos publish images from release.yml; this step is the image push.
export const RELEASE_WORKFLOW = 'release.yml';
export const PUBLISH_STEP = 'Build and push image';
export const DISPATCH_STEP = 'Trigger environment deployment workflow';
// Steps of terraform-dev.yml (main-dev 34264683c2, lines 1466-1519) that produce a saved full-root plan.
export const SAVED_PLAN_STEPS = ['Package saved full-root plan', 'Configure AWS credentials for saved plan storage',
  'Store saved plan in the state bucket', 'Upload saved plan metadata'];
// Frontend repo -> its dev deploy workflow file.
export const FRONTEND_DEPLOY = {
  'equicom-crypto/crypko-frontend': 'deploy-dev.yml',
  'equicom-crypto/backoffice-frontend': 'deploy-dev.yml',
};
// Frontends whose CI workflow also deploys dev: on a push to the deploy branch, from this job.
export const FRONTEND_CI_DEPLOY = {
  'equicom-crypto/crypko-frontend': { workflow: 'ci.yml', job: 'Deploy to Dev' },
};
// GitHub only allows re-running a workflow run within 30 days of its creation; one day of margin.
const RERUN_WINDOW = 31 * 86400;
const MAX_PAGES = 10;

export function requireEnv(env) {
  if (!SUPPORTED_ENVS.includes(env)) throw new CoordError('env_unsupported', `no deploy evidence source for environment ${env} (supported: ${SUPPORTED_ENVS.join(',')})`);
}

export function ghText(args, { timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout, maxBuffer: 256 * 1024 * 1024 }, (err, out, stderr) =>
      err ? reject(new Error(`gh ${args.slice(0, 3).join(' ')}: ${(stderr || err.message).trim().slice(0, 300)}`)) : resolve(out));
  });
}
const ghJson = async (gh, args) => JSON.parse((await gh(args)) || 'null');
const unknown = reason => ({ state: 'unknown', reason, why: reason });
const sec = t => Math.floor((Date.parse(t ?? '') || 0) / 1000);
const attemptTime = r => sec(r.run_started_at ?? r.created_at);
const endTime = r => sec(r.updated_at ?? r.run_started_at ?? r.created_at);
const isWorkflow = (r, file) => (r?.path ?? '').split('@')[0].endsWith(`/${file}`);

// The deploy workflow validates its inputs in two log lines; both must agree on env and binary.
// A run that stopped after the first line is identified (env, binary, tag) but marked partial.
export function parseRunInputs(log) {
  const tag = /validate:release-tag -- --env (\S+) --binary "([\w-]+)" --tag "([\w.-]+)"/.exec(log);
  const img = /validate:ecr-image-provenance --\s+--env (\S+)\s+--binary "([\w-]+)"\s+--image-digest "(sha256:[0-9a-f]{64})"\s+--git-sha "([0-9a-f]{40})"/.exec(log);
  if (!tag) return null;
  if (!img) return { env: tag[1], binary: tag[2], tag: tag[3], partial: true };
  if (tag[1] !== img[1] || tag[2] !== img[2]) return null;
  return { env: tag[1], binary: tag[2], tag: tag[3], digest: img[3], git_sha: img[4] };
}
// Every deploy step comes after this one, so a run where it did not run changed nothing.
export const FIRST_DEPLOY_STEP = 'Validate release tag';

export const runInfo = (repo, id, { gh = ghText } = {}) => ghJson(gh, ['api', `repos/${repo}/actions/runs/${id}`]);

// Jobs of one specific attempt. Logs are fetched only for jobs that ran; a log that cannot be read throws.
export async function attemptJobs(gh, repo, id, attempt, { logs = true } = {}) {
  const res = await ghJson(gh, ['api', `repos/${repo}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`]);
  const jobs = res?.jobs ?? [];
  if (jobs.some(j => j.run_attempt !== undefined && j.run_attempt !== Number(attempt))) throw new Error(`run ${id}: jobs are not from attempt ${attempt}`);
  let log = '';
  if (logs) for (const j of jobs) if (j.conclusion !== 'skipped') log += `${await gh(['api', `repos/${repo}/actions/jobs/${j.id}/logs`])}\n`;
  return { jobs, count: res?.total_count ?? jobs.length, log, done: jobs.every(j => j.status === 'completed') };
}
const step = (jobs, name) => jobs.flatMap(j => j.steps ?? []).find(s => s.name === name);

// Inputs of one completed deploy run attempt, cached per run id and attempt. Returns {none} only when the
// attempt positively never reached release validation; throws when the inputs cannot be read.
export async function deployRunInputs(id, { gh = ghText, attempt = 1 } = {}) {
  const key = `${id}:${attempt}`;
  const hit = get('SELECT inputs FROM run_inputs WHERE run_id=?', key);
  if (hit) return JSON.parse(hit.inputs);
  const { log, count, jobs, done } = await attemptJobs(gh, DEVOPS, id, attempt);
  if (!done) throw new Error(`run ${id} attempt ${attempt}: jobs not finished`);
  let inputs = parseRunInputs(log);
  if (!inputs) {
    const known = jobs.every(j => j.conclusion === 'skipped' || Array.isArray(j.steps));
    const s = step(jobs, FIRST_DEPLOY_STEP);
    if (count && (!known || (s && s.conclusion !== 'skipped'))) throw new Error(`run ${id}: release inputs not found in its logs`);
    inputs = { none: true };
  }
  run('INSERT OR REPLACE INTO run_inputs (run_id,inputs,at) VALUES (?,?,?)', key, JSON.stringify(inputs), Math.floor(Date.now() / 1000));
  return inputs;
}

// A run's latest attempt that provably changed nothing does not erase what an earlier attempt of the
// same run did. `probe(attempt)` classifies one attempt: { skip } (provably changed nothing), { match, data },
// { unknown }, or {} (another target). Walks back from the latest attempt; the first attempt that is not
// a skip decides the run, and its `time` (start by default) is the run's place in the execution order.
async function throughAttempts(gh, repo, r, probe, time = attemptTime) {
  const latest = r.run_attempt ?? 1;
  for (let k = latest; k >= 1; k--) {
    let a = r;
    if (k !== latest) {
      a = await ghJson(gh, ['api', `repos/${repo}/actions/runs/${r.id}/attempts/${k}`]);
      if (a?.status !== 'completed') return { unknown: `run ${r.id} attempt ${k} is ${a?.status}` };
      a = { ...r, ...a, id: r.id, run_attempt: k };
    }
    const m = await probe(a);
    if (m?.skip) continue;
    return { ...m, attempt: k, at: time(a) };
  }
  return {};
}

// Finds the newest executed attempt that `identify` matches across workflow files. Lists are ordered by
// run creation, but a rerun of an older run executes later. So the walk is decided by the newest attempt
// that matches, is unknown, or is unfinished, and only once every workflow has been paged back past that
// attempt's time minus the rerun window (no unseen run can have a newer attempt). Otherwise: unknown.
// `identify` may place a run earlier than its latest attempt (`at`), when only an earlier attempt of it
// did anything; the order is then recomputed with that time. `time` orders attempts (start by default);
// `query` adds list filters per workflow file.
async function latestAttempt({ gh, repo, workflows, identify, maxPages = MAX_PAGES, query = {}, time = attemptTime }) {
  maxPages ??= MAX_PAGES;
  const seen = new Map();
  const memo = new Map();
  const eff = new Map();
  const when = r => eff.get(r._key) ?? time(r);
  const lists = Object.fromEntries(workflows.map(w => [w, { page: 0, done: false, oldest: Infinity }]));
  for (;;) {
    let decided = null;
    for (let again = true; again;) {
      again = false;
      decided = null;
      for (const r of [...seen.values()].sort((a, b) => when(b) - when(a) || b.id - a.id)) {
        if (r.status !== 'completed') { decided = { r, out: unknown(`run ${r.id} is ${r.status}`) }; break; }
        let m = memo.get(r._key)?.m;
        if (!m) {
          try { m = await identify(r); } catch (e) { m = { unknown: `run ${r.id} attempt ${r.run_attempt ?? 1} unreadable: ${e.message}` }; }
          memo.set(r._key, { r, m });
        }
        if (m.at !== undefined && m.at < time(r) && !eff.has(r._key)) { eff.set(r._key, m.at); again = true; break; }
        if (m.unknown) { decided = { r, out: unknown(m.unknown) }; break; }
        if (m.match) { decided = { r, out: { state: 'known', r, attempt: m.attempt ?? r.run_attempt ?? 1, data: m.data, considered: () => [...memo.values()].map(x => x.r) } }; break; }
      }
    }
    const horizon = decided ? when(decided.r) - RERUN_WINDOW : -Infinity;
    const more = workflows.filter(w => !lists[w].done && lists[w].oldest >= horizon);
    if (!more.length) return decided?.out ?? unknown(`no matching run in ${workflows.join(', ')}`);
    for (const w of more) {
      const l = lists[w];
      if (l.page >= maxPages) return unknown(`run list of ${w} not covered after ${maxPages} pages`);
      const res = await ghJson(gh, ['api', `repos/${repo}/actions/workflows/${w}/runs?per_page=100&page=${++l.page}${query[w] ?? ''}`]);
      const runs = res?.workflow_runs ?? [];
      for (const r of runs) { seen.set(`${w}:${r.id}`, { ...r, _key: `${w}:${r.id}` }); l.oldest = Math.min(l.oldest, sec(r.created_at)); }
      if (runs.length < 100) l.done = true;
    }
  }
}

// Confirms the chosen attempt is still the run's latest, so a rerun that started meanwhile is not missed.
async function recheck(gh, repo, r) {
  const cur = await runInfo(repo, r.id, { gh });
  return cur?.status === 'completed' && (cur.run_attempt ?? 1) === (r.run_attempt ?? 1);
}

// Before a runtime is reported known, every run discovery classified (the winner, runs skipped as no-ops,
// runs placed earlier than their latest attempt) is re-read by id: each must still be completed at the
// attempt discovery saw. Returns null, or the reason the result must be unknown. Nothing is cached.
async function recheckConsidered(gh, repo, found) {
  const runs = new Map([[found.r.id, found.r], ...found.considered().map(r => [r.id, r])]);
  for (const r of runs.values()) {
    let ok;
    try { ok = await recheck(gh, repo, r); } catch (e) { return `run ${r.id} could not be re-read: ${e.message}`; }
    if (!ok) return `run ${r.id} moved past attempt ${r.run_attempt ?? 1} or is running again while discovery read it`;
  }
  return null;
}

const shape = (state, o = {}) => ({ state, sha: o.sha ?? null, tag: o.tag ?? null, digest: o.digest ?? null,
  run: o.run ?? null, attempt: o.attempt ?? null, reason: o.reason ?? null });

// What is live for a service binary in an environment.
// Returns { state: 'known'|'unknown', sha, tag, digest, run, attempt, reason }.
export async function serviceRuntime({ binary, env = 'dev', gh = ghText, maxPages } = {}) {
  requireEnv(env);
  binary = String(binary ?? '').toLowerCase();
  const found = await latestAttempt({
    gh, repo: DEVOPS, workflows: SERVICE_DEPLOY_WORKFLOWS, maxPages,
    identify: r => throughAttempts(gh, DEVOPS, r, async a => {
      const inputs = await deployRunInputs(a.id, { gh, attempt: a.run_attempt });
      if (inputs.none) return { skip: true }; // never reached release validation: changed nothing
      if (inputs.binary !== binary) return {};
      if (inputs.env !== env) return { unknown: `run ${a.id} attempt ${a.run_attempt} deployed ${binary} to ${inputs.env}` };
      if (a.conclusion !== 'success' || inputs.partial) return { unknown: `latest ${binary} run ${a.id} attempt ${a.run_attempt} ended ${a.conclusion}` };
      return { match: true, data: inputs };
    }),
  }).catch(e => unknown(e.message));
  if (found.state !== 'known') return shape('unknown', { reason: found.reason });
  const { r, data, attempt } = found;
  const moved = await recheckConsidered(gh, DEVOPS, found);
  if (moved) return shape('unknown', { reason: moved });
  return shape('known', { sha: data.git_sha, tag: data.tag, digest: data.digest, run: String(r.id), attempt });
}

// Frontend jobs that ran beyond the manual-actor authorization job.
async function frontendExecuted(gh, repo, r) {
  const key = `fe:${repo}:${r.id}:${r.run_attempt ?? 1}`;
  const hit = get('SELECT inputs FROM run_inputs WHERE run_id=?', key);
  if (hit) return JSON.parse(hit.inputs).executed;
  const { jobs, done } = await attemptJobs(gh, repo, r.id, r.run_attempt ?? 1, { logs: false });
  if (!done) throw new Error('jobs not finished');
  const executed = jobs.some(j => j.conclusion !== 'skipped' && !/^authorize/i.test(j.name ?? ''));
  run('INSERT OR REPLACE INTO run_inputs (run_id,inputs,at) VALUES (?,?,?)', key, JSON.stringify({ executed }), Math.floor(Date.now() / 1000));
  return executed;
}

// The CI workflow's dev deploy job in one attempt: 'none' (not a push to the deploy branch, or the job never
// started), 'missing' (the attempt has jobs but not that one), or the job's conclusion.
async function ciDeploy(gh, repo, r) {
  if (r.event !== 'push' || r.head_branch !== BRANCH) return 'none';
  const key = `feci:${repo}:${r.id}:${r.run_attempt ?? 1}`;
  const hit = get('SELECT inputs FROM run_inputs WHERE run_id=?', key);
  if (hit) return JSON.parse(hit.inputs).deploy;
  const { jobs, done } = await attemptJobs(gh, repo, r.id, r.run_attempt ?? 1, { logs: false });
  if (!done) throw new Error('jobs not finished');
  const j = jobs.find(x => x.name === FRONTEND_CI_DEPLOY[repo].job);
  const started = j && j.conclusion !== 'skipped' && (!Array.isArray(j.steps) || j.steps.some(s => s.conclusion !== 'skipped'));
  const deploy = !j ? (jobs.length ? 'missing' : 'none') : started ? j.conclusion : 'none';
  run('INSERT OR REPLACE INTO run_inputs (run_id,inputs,at) VALUES (?,?,?)', key, JSON.stringify({ deploy }), Math.floor(Date.now() / 1000));
  return deploy;
}

// What is live for a frontend repo: the head of its newest executed deploy-workflow attempt. A repo whose
// CI also deploys has two sources; then the attempt that finished last wins.
// Returns { state: 'known'|'unknown', sha, tag: null, digest: null, run, attempt, reason }.
export async function frontendRuntime({ repo, env = 'dev', gh = ghText } = {}) {
  requireEnv(env);
  repo = String(repo ?? '').toLowerCase();
  const wf = FRONTEND_DEPLOY[repo];
  if (!wf) return shape('unknown', { reason: `no deploy workflow configured for ${repo}` });
  const ci = FRONTEND_CI_DEPLOY[repo];
  const time = ci ? endTime : attemptTime;
  const found = await latestAttempt({
    gh, repo, workflows: ci ? [wf, ci.workflow] : [wf], time,
    query: ci ? { [ci.workflow]: `&event=push&branch=${BRANCH}` } : {},
    identify: r => throughAttempts(gh, repo, r, async a => {
      if (ci && isWorkflow(a, ci.workflow)) {
        const d = await ciDeploy(gh, repo, a);
        if (d === 'none') return { skip: true };
        if (d !== 'success' || a.conclusion !== 'success') return { unknown: `latest CI run ${a.id} attempt ${a.run_attempt}: ${ci.job} ${d}, run ${a.conclusion}` };
        return { match: true, data: { sha: a.head_sha } };
      }
      if (!(await frontendExecuted(gh, repo, a))) return { skip: true };
      if (a.conclusion !== 'success') return { unknown: `latest deploy run ${a.id} attempt ${a.run_attempt} ended ${a.conclusion}` };
      return { match: true, data: { sha: a.head_sha } };
    }, time),
  }).catch(e => unknown(e.message));
  if (found.state !== 'known') return shape('unknown', { reason: found.reason });
  const moved = await recheckConsidered(gh, repo, found);
  if (moved) return shape('unknown', { reason: moved });
  return shape('known', { sha: found.data.sha, run: String(found.r.id), attempt: found.attempt });
}

// compare base...head through gh.
const compareStatus = async (gh, repo, base, head) =>
  (await ghJson(gh, ['api', `repos/${repo}/compare/${base}...${head}`, '--jq', '{status: .status}']))?.status;

// True when `observed` contains `sha`: compare observed...sha is behind (sha is an ancestor) or identical.
export async function contains(repo, sha, observed, { gh = ghText } = {}) {
  return ['behind', 'identical'].includes(await compareStatus(gh, repo, observed, sha));
}

// Release admission revalidation: the pinned sha must still be on the deploy branch.
export async function verifyHead(release, { gh = ghText, branch = BRANCH } = {}) {
  try {
    return (await contains(release.repo, release.git_sha, branch, { gh }))
      ? { ok: true } : { ok: false, reason: `${release.git_sha.slice(0, 12)} is not on ${branch}` };
  } catch (e) {
    // A sha GitHub no longer knows (history rewritten) is stale, not a transient failure.
    return /No commit found|HTTP 404/.test(e.message) ? { ok: false, reason: e.message } : { ok: false, transient: true, reason: e.message };
  }
}

// A saved Terraform plan run attempt. terraform-dev.yml's saved-plan apply takes only a run id and uses
// that run's latest attempt, so the pinned attempt must still be the latest, and that attempt must have
// produced and stored the saved full-root plan. Used at admission and again at start.
export async function planRun(planId, { gh = ghText } = {}) {
  const m = /^saved:(\d+)@(\d+)$/.exec(planId ?? '');
  if (!m) throw new CoordError('invalid', `plan ${planId} is not saved:<run>@<attempt>`);
  const [run_, attempt] = [m[1], Number(m[2])];
  const cur = await runInfo(DEVOPS, run_, { gh });
  if ((cur?.run_attempt ?? 1) !== attempt)
    throw new CoordError('plan_attempt_moved', `run ${run_} is at attempt ${cur?.run_attempt}, plan pins attempt ${attempt}; the apply would use the latest`);
  const a = await ghJson(gh, ['api', `repos/${DEVOPS}/actions/runs/${run_}/attempts/${attempt}`]);
  if (!isWorkflow(a, 'terraform-dev.yml')) throw new CoordError('plan_unverified', `run ${run_} is ${a?.path}, not terraform-dev.yml`);
  if (a.status !== 'completed' || a.conclusion !== 'success') throw new CoordError('plan_unverified', `plan run ${run_} attempt ${attempt} is ${a.status}/${a.conclusion}`);
  if (a.head_branch !== BRANCH) throw new CoordError('plan_unverified', `plan run ${run_} ran on ${a.head_branch}`);
  const { jobs, done } = await attemptJobs(gh, DEVOPS, run_, attempt, { logs: false });
  const missing = SAVED_PLAN_STEPS.filter(n => step(jobs, n)?.conclusion !== 'success');
  if (!done || missing.length) throw new CoordError('plan_unverified', `plan run ${run_} attempt ${attempt} did not save a full-root plan (${missing.join(', ') || 'jobs unfinished'})`);
  // A rerun that started while the evidence above was read would be the attempt the apply uses.
  const after = await runInfo(DEVOPS, run_, { gh });
  if ((after?.run_attempt ?? 1) !== attempt || after?.status !== 'completed')
    throw new CoordError('plan_attempt_moved', `run ${run_} moved to attempt ${after?.run_attempt} (${after?.status}) while plan attempt ${attempt} was verified`);
  return { run: run_, attempt, startedAt: attemptTime(a), headSha: a.head_sha };
}

// Latest attempt number of a run (manual Terraform closeout checks the plan's attempt did not move).
export const currentAttempt = async (runId, { gh = ghText } = {}) => (await runInfo(DEVOPS, runId, { gh }))?.run_attempt ?? 1;

// Pure classification of a service release from its Release run and the downstream deploy run.
// A known downstream decides; a parent failure alone never ends the operation.
// `dispatched`: 'yes' (link found), 'no' (the dispatch step provably did not run), or 'unknown'.
// `published`: 'yes' (push step succeeded), 'no' (it provably never ran), or 'unknown' (it started and
// did not succeed: the push may have happened before a later check in the same step failed).
export function classify({ release, published: pub, dispatched = 'yes', downstream, downstreamJobs, inputs, expect, releaseAgeSec, waitSec = 1800 }) {
  const published = pub === true ? 'yes' : pub === false ? 'no' : pub ?? 'unknown';
  if (downstream) {
    if (!isWorkflow(downstream, SERVICE_DEPLOY_WORKFLOW)) return unknown(`run ${downstream.id} is not ${SERVICE_DEPLOY_WORKFLOW}`);
    if (downstream.status !== 'completed') return { state: 'running', why: 'downstream running' };
    if (!release || release.status !== 'completed') return { state: 'running', why: 'release run not finished' };
    if (downstream.conclusion === 'cancelled' && !downstreamJobs)
      return published === 'yes' ? { state: 'built_not_deployed', failure: `image published, downstream ${downstream.id} cancelled before any job` }
        : unknown(`downstream ${downstream.id} cancelled before any job; image publication not shown`);
    if (downstream.conclusion !== 'success') return { state: 'failed', failure: `downstream ${downstream.id} ${downstream.conclusion}` };
    if (!inputs) return unknown(`downstream ${downstream.id} inputs unreadable`);
    for (const k of ['env', 'binary', 'git_sha']) if (!expect[k]) return unknown(`release has no ${k} bound`);
    for (const k of ['env', 'binary', 'tag', 'digest', 'git_sha'])
      if (expect[k] && inputs[k] !== expect[k]) return { state: 'failed', failure: `downstream deployed ${k}=${inputs[k]}, expected ${expect[k]}` };
    return { state: 'done', digest: inputs.digest };
  }
  if (!release || release.status !== 'completed') return { state: 'running', why: 'release run not finished' };
  if (dispatched === 'no') return published === 'yes' ? { state: 'built_not_deployed', failure: `image published, no downstream dispatched (release ${release.conclusion})` }
    : published === 'no' ? { state: 'failed', failure: `release run ${release.conclusion}; push step never ran and nothing was dispatched` }
    : unknown(`release run ${release.conclusion}: the push step started but did not succeed, so an image may exist; reconcile built or failed with evidence`);
  if (dispatched === 'unknown') return unknown(`release run ${release.conclusion}: cannot tell whether a downstream deploy was dispatched; reconcile manually`);
  return releaseAgeSec > waitSec ? unknown('dispatch step ran but no downstream run was found; reconcile manually')
    : { state: 'running', why: 'downstream not found yet' };
}

async function observeFrontend(r, gh) {
  if (!r.deploy_run) return { state: 'running', why: 'no deploy run recorded' };
  const wf = FRONTEND_DEPLOY[r.repo];
  if (!wf) return unknown(`no deploy workflow configured for ${r.repo}`);
  const ci = FRONTEND_CI_DEPLOY[r.repo];
  const d = await runInfo(r.repo, r.deploy_run, { gh });
  const viaCi = ci && isWorkflow(d, ci.workflow);
  if (!viaCi && !isWorkflow(d, wf)) return unknown(`run ${r.deploy_run} is ${d?.path}, not ${wf}${ci ? ` or ${ci.workflow}` : ''}`);
  if (d.status !== 'completed') return { state: 'running', why: 'deploy run not finished' };
  if (d.conclusion !== 'success')
    return (await recheck(gh, r.repo, d).catch(() => false)) ? { state: 'failed', failure: `deploy run ${d.conclusion}` } : unknown(`run ${d.id} changed while reading`);
  let executed;
  try { executed = viaCi ? (await ciDeploy(gh, r.repo, d)) === 'success' : await frontendExecuted(gh, r.repo, d); } catch (e) { return unknown(`deploy run jobs unreadable: ${e.message}`); }
  if (!executed) return unknown(`deploy run ${d.id} executed no deploy job`);
  let ok;
  try { ok = await contains(r.repo, r.git_sha, d.head_sha, { gh }); } catch (e) { return unknown(`compare failed: ${e.message}`); }
  if (!(await recheck(gh, r.repo, d).catch(() => false))) return unknown(`run ${d.id} changed while reading`);
  const readback = { observed_head: d.head_sha, run: d.html_url, attempt: d.run_attempt ?? 1 };
  return ok ? { state: 'done', readback, outcome: d.head_sha === r.git_sha ? 'done' : `done at observed ${d.head_sha}` }
    : { state: 'failed', failure: `observed ${d.head_sha} does not contain requested ${r.git_sha}`, readback };
}

// Observer for coord.releaseObserve (deploy kinds only).
// Returns {state: running|unknown|done|failed|built_not_deployed, ...}.
export async function observeRelease(r, { gh = ghText, now = Math.floor(Date.now() / 1000) } = {}) {
  requireEnv(r.environment);
  if (!['service_release', 'redispatch', 'frontend_release'].includes(r.kind)) return { state: 'running', why: `${r.kind} is closed with release reconcile` };
  if (r.kind === 'frontend_release') return observeFrontend(r, gh);
  const expect = { env: r.environment, binary: r.binary, tag: r.tag, digest: r.image_digest, git_sha: r.git_sha };
  // Run attempts and the downstream run are bound at first sight and persisted (`bind`). Any later attempt
  // change, a parent first seen past attempt 1, or a downstream link that is not the bound run means an
  // unaccounted dispatch may exist: unknown, so the release keeps its locks until reconciled by hand.
  const bind = {};
  let release = null, published = 'no', dispatched = 'yes', downstreamId = r.deploy_run;
  if (r.kind === 'redispatch') release = { status: 'completed', conclusion: 'success' }, published = 'yes';
  else if (r.release_run) {
    release = await runInfo(r.repo, r.release_run, { gh });
    if (!isWorkflow(release, RELEASE_WORKFLOW)) return unknown(`run ${r.release_run} is ${release?.path}, not ${RELEASE_WORKFLOW}`);
    if (release.event === 'workflow_dispatch') return unknown('workflow_dispatch provenance unsupported; reconcile manually');
    if (release.head_sha !== r.git_sha || (r.tag && release.head_branch !== r.tag))
      return unknown(`release run ${release.id} is ${release.head_branch}@${release.head_sha}, not ${r.tag}@${r.git_sha}`);
    const att = release.run_attempt ?? 1;
    if (r.release_attempt != null && att !== r.release_attempt)
      return unknown(`release run ${release.id} moved from attempt ${r.release_attempt} to ${att}; an earlier attempt may have dispatched a deploy; reconcile manually`);
    if (r.release_attempt == null && att !== 1)
      return unknown(`release run ${release.id} first observed at attempt ${att}; earlier attempts may have dispatched a deploy; reconcile manually`);
    bind.release_attempt = att;
    if (release.status === 'completed') {
      let jobs;
      try { jobs = await attemptJobs(gh, r.repo, release.id, att); } catch (e) { return unknown(`release run jobs unreadable: ${e.message}`); }
      const links = [...new Set([...jobs.log.matchAll(/crpko-devops\/actions\/runs\/(\d+)/gi)].map(m => m[1]))];
      if (links.length > 1 || (downstreamId && links.length && links[0] !== String(downstreamId)))
        return unknown(`release run ${release.id} dispatched ${links.join(', ')}, bound downstream is ${downstreamId ?? 'none'}; reconcile manually`);
      // A step that is absent counts as not run only when every job of the attempt was skipped.
      const ps = step(jobs.jobs, PUBLISH_STEP);
      const allSkipped = jobs.done && jobs.jobs.length > 0 && jobs.jobs.every(j => j.conclusion === 'skipped');
      published = ps?.conclusion === 'success' ? 'yes' : ps?.conclusion === 'skipped' || (!ps && allSkipped) ? 'no' : 'unknown';
      if (!downstreamId) {
        downstreamId = links[0];
        // Without a link in the logs: 'no' only when the dispatch step is shown not to have run.
        const d = step(jobs.jobs, DISPATCH_STEP);
        dispatched = downstreamId ? 'yes'
          : jobs.done && (d?.conclusion === 'skipped' || (!d && allSkipped)) ? 'no'
          : jobs.done && d?.conclusion === 'success' ? 'yes' : 'unknown';
      }
    }
  }
  if (downstreamId) bind.deploy_run = String(downstreamId);
  const downstream = downstreamId ? await runInfo(DEVOPS, downstreamId, { gh }) : null;
  if (downstream) {
    const datt = downstream.run_attempt ?? 1;
    if (r.deploy_attempt != null && datt !== r.deploy_attempt)
      return unknown(`deploy run ${downstream.id} moved from attempt ${r.deploy_attempt} to ${datt}; reconcile manually`);
    bind.deploy_attempt = datt;
  }
  const finished = downstream?.status === 'completed';
  let jobs = 0, inputs = null;
  if (finished) {
    try {
      jobs = (await attemptJobs(gh, DEVOPS, downstreamId, downstream.run_attempt ?? 1, { logs: false })).count;
      if (downstream.conclusion === 'success') {
        inputs = await deployRunInputs(downstreamId, { gh, attempt: downstream.run_attempt ?? 1 });
        if (inputs.none || inputs.partial) inputs = null;
      }
    } catch (e) { return { ...unknown(`downstream ${downstreamId} unreadable: ${e.message}`), bind }; }
  }
  const age = release?.updated_at ? now - sec(release.updated_at) : now - (r.updated_at ?? now);
  const c = classify({ release, published, dispatched, downstream, downstreamJobs: jobs, inputs, expect, releaseAgeSec: age });
  // Before any terminal result, both runs must still be at the attempts that were read and finished.
  if (['done', 'failed', 'built_not_deployed'].includes(c.state)) {
    for (const [repo, run_] of [[r.repo, r.kind === 'redispatch' ? null : release], [DEVOPS, downstream]])
      if (run_ && !(await recheck(gh, repo, run_).catch(() => false))) return { ...unknown(`run ${run_.id} moved to a new attempt or is running again`), bind };
  }
  return { ...c, bind, readback: { release_run: r.release_run, release_attempt: release?.run_attempt ?? null, deploy_run: downstreamId ?? null, attempt: downstream?.run_attempt ?? null, inputs } };
}

// Evaluator for coord.ready: pr_merged / pr_deployed refs look like `owner/repo#123` or `owner/repo#123@binary`.
export async function external(dep, { gh = ghText } = {}) {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)(?:@([\w-]+))?$/.exec(dep.ref);
  if (!m) return { state: 'waiting', why: 'ref must be owner/repo#N[@binary]' };
  const pr = await ghJson(gh, ['pr', 'view', m[2], '--repo', m[1], '--json', 'state,mergeCommit']);
  if (pr?.state !== 'MERGED') return { state: 'waiting', why: `PR ${pr?.state ?? 'unknown'}` };
  const sha = pr.mergeCommit?.oid;
  if (dep.need === 'pr_merged') return { state: 'ready', why: 'merged', evidence: sha };
  const repo = m[1].toLowerCase();
  const rt = FRONTEND_DEPLOY[repo] ? await frontendRuntime({ repo, gh }) : await serviceRuntime({ binary: m[3] ?? repo.split('/')[1], gh });
  if (rt.state !== 'known') return { state: 'waiting', why: rt.reason };
  return (await contains(m[1], sha, rt.sha, { gh }))
    ? { state: 'ready', why: `in running ${rt.tag ?? rt.sha}`, evidence: `run ${rt.run} attempt ${rt.attempt} ${rt.digest ?? rt.sha}` }
    : { state: 'waiting', why: `not in running ${rt.tag ?? rt.sha} (run ${rt.run})` };
}

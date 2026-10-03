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

// Finds the newest executed attempt that `identify` matches across workflow files. Lists are ordered by
// run creation, but a rerun of an older run executes later. So the walk is decided by the newest attempt
// that matches, is unknown, or is unfinished, and only once every workflow has been paged back past that
// attempt's time minus the rerun window (no unseen run can have a newer attempt). Otherwise: unknown.
async function latestAttempt({ gh, repo, workflows, identify, maxPages = MAX_PAGES }) {
  maxPages ??= MAX_PAGES;
  const seen = new Map();
  const lists = Object.fromEntries(workflows.map(w => [w, { page: 0, done: false, oldest: Infinity }]));
  for (;;) {
    let decided = null;
    for (const r of [...seen.values()].sort((a, b) => attemptTime(b) - attemptTime(a) || b.id - a.id)) {
      if (r.status !== 'completed') { decided = { r, out: unknown(`run ${r.id} is ${r.status}`) }; break; }
      let m;
      try { m = await identify(r); } catch (e) { decided = { r, out: unknown(`run ${r.id} attempt ${r.run_attempt ?? 1} unreadable: ${e.message}`) }; break; }
      if (m?.unknown) { decided = { r, out: unknown(m.unknown) }; break; }
      if (m?.match) { decided = { r, out: { state: 'known', r, data: m.data } }; break; }
    }
    const horizon = decided ? attemptTime(decided.r) - RERUN_WINDOW : -Infinity;
    const more = workflows.filter(w => !lists[w].done && lists[w].oldest >= horizon);
    if (!more.length) return decided?.out ?? unknown(`no matching run in ${workflows.join(', ')}`);
    for (const w of more) {
      const l = lists[w];
      if (l.page >= maxPages) return unknown(`run list of ${w} not covered after ${maxPages} pages`);
      const res = await ghJson(gh, ['api', `repos/${repo}/actions/workflows/${w}/runs?per_page=100&page=${++l.page}`]);
      const runs = res?.workflow_runs ?? [];
      for (const r of runs) { seen.set(`${w}:${r.id}`, r); l.oldest = Math.min(l.oldest, sec(r.created_at)); }
      if (runs.length < 100) l.done = true;
    }
  }
}

// Confirms the chosen attempt is still the run's latest, so a rerun that started meanwhile is not missed.
async function recheck(gh, repo, r) {
  const cur = await runInfo(repo, r.id, { gh });
  return cur?.status === 'completed' && (cur.run_attempt ?? 1) === (r.run_attempt ?? 1);
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
    identify: async r => {
      const inputs = await deployRunInputs(r.id, { gh, attempt: r.run_attempt ?? 1 });
      if (inputs.none || inputs.binary !== binary) return { match: false };
      if (inputs.env !== env) return { unknown: `run ${r.id} deployed ${binary} to ${inputs.env}` };
      if (r.conclusion !== 'success' || inputs.partial) return { unknown: `latest ${binary} run ${r.id} ended ${r.conclusion}` };
      return { match: true, data: inputs };
    },
  }).catch(e => unknown(e.message));
  if (found.state !== 'known') return shape('unknown', { reason: found.reason });
  const { r, data } = found;
  if (!(await recheck(gh, DEVOPS, r).catch(() => false))) return shape('unknown', { reason: `run ${r.id} changed while reading` });
  return shape('known', { sha: data.git_sha, tag: data.tag, digest: data.digest, run: String(r.id), attempt: r.run_attempt ?? 1 });
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

// What is live for a frontend repo: the head of its newest executed deploy-workflow attempt.
// Returns { state: 'known'|'unknown', sha, tag: null, digest: null, run, attempt, reason }.
export async function frontendRuntime({ repo, env = 'dev', gh = ghText } = {}) {
  requireEnv(env);
  repo = String(repo ?? '').toLowerCase();
  const wf = FRONTEND_DEPLOY[repo];
  if (!wf) return shape('unknown', { reason: `no deploy workflow configured for ${repo}` });
  const found = await latestAttempt({
    gh, repo, workflows: [wf],
    identify: async r => {
      if (!(await frontendExecuted(gh, repo, r))) return { match: false };
      if (r.conclusion !== 'success') return { unknown: `latest deploy run ${r.id} ended ${r.conclusion}` };
      return { match: true, data: { sha: r.head_sha } };
    },
  }).catch(e => unknown(e.message));
  if (found.state !== 'known') return shape('unknown', { reason: found.reason });
  if (!(await recheck(gh, repo, found.r).catch(() => false))) return shape('unknown', { reason: `run ${found.r.id} changed while reading` });
  return shape('known', { sha: found.data.sha, run: String(found.r.id), attempt: found.r.run_attempt ?? 1 });
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
  return { run: run_, attempt, startedAt: attemptTime(a), headSha: a.head_sha };
}

// Latest attempt number of a run (manual Terraform closeout checks the plan's attempt did not move).
export const currentAttempt = async (runId, { gh = ghText } = {}) => (await runInfo(DEVOPS, runId, { gh }))?.run_attempt ?? 1;

// Pure classification of a service release from its Release run and the downstream deploy run.
// A known downstream decides; a parent failure alone never ends the operation.
// `dispatched`: 'yes' (link found), 'no' (the dispatch step provably did not run), or 'unknown'.
export function classify({ release, published, dispatched = 'yes', downstream, downstreamJobs, inputs, expect, releaseAgeSec, waitSec = 1800 }) {
  if (downstream) {
    if (!isWorkflow(downstream, SERVICE_DEPLOY_WORKFLOW)) return unknown(`run ${downstream.id} is not ${SERVICE_DEPLOY_WORKFLOW}`);
    if (downstream.status !== 'completed') return { state: 'running', why: 'downstream running' };
    if (!release || release.status !== 'completed') return { state: 'running', why: 'release run not finished' };
    if (downstream.conclusion === 'cancelled' && !downstreamJobs)
      return published ? { state: 'built_not_deployed', failure: `image published, downstream ${downstream.id} cancelled before any job` }
        : unknown(`downstream ${downstream.id} cancelled before any job; image publication not shown`);
    if (downstream.conclusion !== 'success') return { state: 'failed', failure: `downstream ${downstream.id} ${downstream.conclusion}` };
    if (!inputs) return unknown(`downstream ${downstream.id} inputs unreadable`);
    for (const k of ['env', 'binary', 'git_sha']) if (!expect[k]) return unknown(`release has no ${k} bound`);
    for (const k of ['env', 'binary', 'tag', 'digest', 'git_sha'])
      if (expect[k] && inputs[k] !== expect[k]) return { state: 'failed', failure: `downstream deployed ${k}=${inputs[k]}, expected ${expect[k]}` };
    return { state: 'done', digest: inputs.digest };
  }
  if (!release || release.status !== 'completed') return { state: 'running', why: 'release run not finished' };
  if (dispatched === 'no') return published ? { state: 'built_not_deployed', failure: `image published, no downstream dispatched (release ${release.conclusion})` }
    : { state: 'failed', failure: `release run ${release.conclusion}; nothing published or dispatched` };
  if (dispatched === 'unknown') return unknown(`release run ${release.conclusion}: cannot tell whether a downstream deploy was dispatched; reconcile manually`);
  return releaseAgeSec > waitSec ? unknown('dispatch step ran but no downstream run was found; reconcile manually')
    : { state: 'running', why: 'downstream not found yet' };
}

async function observeFrontend(r, gh) {
  if (!r.deploy_run) return { state: 'running', why: 'no deploy run recorded' };
  const wf = FRONTEND_DEPLOY[r.repo];
  if (!wf) return unknown(`no deploy workflow configured for ${r.repo}`);
  const d = await runInfo(r.repo, r.deploy_run, { gh });
  if (!isWorkflow(d, wf)) return unknown(`run ${r.deploy_run} is ${d?.path}, not ${wf}`);
  if (d.status !== 'completed') return { state: 'running', why: 'deploy run not finished' };
  if (d.conclusion !== 'success')
    return (await recheck(gh, r.repo, d).catch(() => false)) ? { state: 'failed', failure: `deploy run ${d.conclusion}` } : unknown(`run ${d.id} changed while reading`);
  let executed;
  try { executed = await frontendExecuted(gh, r.repo, d); } catch (e) { return unknown(`deploy run jobs unreadable: ${e.message}`); }
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
  let release = null, published = false, dispatched = 'yes', downstreamId = r.deploy_run;
  if (r.kind === 'redispatch') release = { status: 'completed', conclusion: 'success' }, published = true;
  else if (r.release_run) {
    release = await runInfo(r.repo, r.release_run, { gh });
    if (!isWorkflow(release, RELEASE_WORKFLOW)) return unknown(`run ${r.release_run} is ${release?.path}, not ${RELEASE_WORKFLOW}`);
    if (release.event === 'workflow_dispatch') return unknown('workflow_dispatch provenance unsupported; reconcile manually');
    if (release.head_sha !== r.git_sha || (r.tag && release.head_branch !== r.tag))
      return unknown(`release run ${release.id} is ${release.head_branch}@${release.head_sha}, not ${r.tag}@${r.git_sha}`);
    if (release.status === 'completed') {
      let jobs;
      try { jobs = await attemptJobs(gh, r.repo, release.id, release.run_attempt ?? 1, { logs: !downstreamId }); }
      catch (e) { if (!downstreamId) return unknown(`release run jobs unreadable: ${e.message}`); }
      if (jobs) {
        published = step(jobs.jobs, PUBLISH_STEP)?.conclusion === 'success';
        if (!downstreamId) {
          downstreamId = /crpko-devops\/actions\/runs\/(\d+)/i.exec(jobs.log)?.[1];
          // Without a link in the logs: 'no' only when the dispatch step is shown not to have run.
          const d = step(jobs.jobs, DISPATCH_STEP);
          dispatched = downstreamId ? 'yes'
            : jobs.done && d?.conclusion === 'skipped' ? 'no'
            : jobs.done && d?.conclusion === 'success' ? 'yes' : 'unknown';
        }
      }
    }
  }
  const downstream = downstreamId ? await runInfo(DEVOPS, downstreamId, { gh }) : null;
  const finished = downstream?.status === 'completed';
  let jobs = 0, inputs = null;
  if (finished) {
    try {
      jobs = (await attemptJobs(gh, DEVOPS, downstreamId, downstream.run_attempt ?? 1, { logs: false })).count;
      if (downstream.conclusion === 'success') {
        inputs = await deployRunInputs(downstreamId, { gh, attempt: downstream.run_attempt ?? 1 });
        if (inputs.none || inputs.partial) inputs = null;
      }
    } catch (e) { return unknown(`downstream ${downstreamId} unreadable: ${e.message}`); }
  }
  const age = release?.updated_at ? now - sec(release.updated_at) : now - (r.updated_at ?? now);
  const c = classify({ release, published, dispatched, downstream, downstreamJobs: jobs, inputs, expect, releaseAgeSec: age });
  // Before any terminal result, both runs must still be at the attempts that were read and finished.
  if (['done', 'failed', 'built_not_deployed'].includes(c.state)) {
    for (const [repo, run_] of [[r.repo, r.kind === 'redispatch' ? null : release], [DEVOPS, downstream]])
      if (run_ && !(await recheck(gh, repo, run_).catch(() => false))) return unknown(`run ${run_.id} moved to a new attempt or is running again`);
  }
  return { ...c, readback: { release_run: r.release_run, release_attempt: release?.run_attempt ?? null, deploy_run: downstreamId ?? null, attempt: downstream?.run_attempt ?? null, inputs } };
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

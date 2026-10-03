// Revision-specific deploy evidence from GitHub. Read-only: it only runs `gh` queries.
// Everything here fails closed: anything it cannot positively identify is `unknown`, never older evidence.
import { execFile } from 'node:child_process';
import { get, run, CoordError } from './db.mjs';

export const DEVOPS = 'Equicom-Crypto/crpko-devops';
export const DEVOPS_WORKFLOW = 'deploy-dev-service.yml';
export const BRANCH = process.env.COORD_DEPLOY_BRANCH || 'main-dev';
export const SUPPORTED_ENVS = ['dev']; // environments with an evidence source; others are refused

// How a Terraform / migration run proves it executed the admitted operation.
// plan_id formats: tf_apply `saved:<plan run id>` or `scope:<infra-only scope>`; ddl/migration `<file>.sql[@<checksum>]`.
export const EXEC_RULES = {
  tf_apply: {
    workflow: 'terraform-dev.yml',
    identity: plan => {
      const m = /^(saved|scope):([\w.-]+)$/.exec(plan ?? '');
      if (!m) return null;
      return m[1] === 'saved'
        ? { lines: [`SAVED_PLAN_RUN_ID: ${m[2]}`], step: 'Apply saved plan' }
        : { lines: [`FOUNDATIONDB_EXPLORER_SCOPE: ${m[2]}`, 'INFRA_ONLY: true'], step: 'Terraform apply' };
    },
  },
  migration: {
    workflow: 'apply-clickhouse-migration.yml',
    identity: plan => {
      const m = /^([\w.-]+\.sql)(?:@([0-9a-f]{8,64}))?$/.exec(plan ?? '');
      return m && { lines: [`MIGRATION_FILE: ${m[1]}`, 'APPLY: true', 'VERIFY_ONLY: false', ...(m[2] ? [m[2]] : [])], step: 'Apply gated migration' };
    },
  },
};
EXEC_RULES.ddl = EXEC_RULES.migration;

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
const unknown = why => ({ state: 'unknown', why });

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
// Every deploy step comes after this one, so a run where it did not succeed changed nothing.
export const FIRST_DEPLOY_STEP = 'Validate release tag';

export const runInfo = (repo, id, { gh = ghText } = {}) => ghJson(gh, ['api', `repos/${repo}/actions/runs/${id}`]);
const isWorkflow = (r, file) => (r?.path ?? '').split('@')[0].endsWith(`/${file}`);

// Jobs of the latest attempt, with their logs. A log that cannot be fetched is an error, not an empty string.
async function runJobs(gh, repo, id, { logs = true } = {}) {
  const res = await ghJson(gh, ['api', `repos/${repo}/actions/runs/${id}/jobs?per_page=100`]);
  const jobs = res?.jobs ?? [];
  let log = '';
  if (logs) for (const j of jobs) log += `${await gh(['api', `repos/${repo}/actions/jobs/${j.id}/logs`])}\n`;
  return { jobs, count: res?.total_count ?? jobs.length, log };
}

// Inputs of a completed deploy run attempt, cached per run id and attempt. Returns {none} only when the
// run positively never reached release validation; throws when the inputs cannot be read.
export async function deployRunInputs(id, { gh = ghText, attempt = 1 } = {}) {
  const key = `${id}:${attempt}`;
  const hit = get('SELECT inputs FROM run_inputs WHERE run_id=?', key);
  if (hit) return JSON.parse(hit.inputs);
  const { log, count, jobs } = await runJobs(gh, DEVOPS, id);
  let inputs = parseRunInputs(log);
  if (!inputs) {
    // Only a run whose jobs all finished with step data and never passed release validation is "no deploy".
    const known = jobs.every(j => j.status === 'completed' && Array.isArray(j.steps));
    const reached = jobs.flatMap(j => j.steps ?? []).some(s => s.name === FIRST_DEPLOY_STEP && s.conclusion !== 'skipped');
    if (count && (!known || reached)) throw new Error(`run ${id}: release inputs not found in its logs`);
    inputs = { none: true };
  }
  run('INSERT OR REPLACE INTO run_inputs (run_id,inputs,at) VALUES (?,?,?)', key, JSON.stringify(inputs), Math.floor(Date.now() / 1000));
  return inputs;
}

const attemptTime = r => Date.parse(r.run_started_at ?? r.created_at ?? 0) || 0;

// What is live for a binary: walk deploy runs newest attempt first. The first run that names the binary
// decides; a newer run that cannot be read, is still running, or failed for this binary makes it unknown.
export async function serviceRuntime({ binary, env = 'dev', limit = 50, gh = ghText } = {}) {
  requireEnv(env);
  const res = await ghJson(gh, ['api', `repos/${DEVOPS}/actions/workflows/${DEVOPS_WORKFLOW}/runs?per_page=${limit}`]);
  const runs = (res?.workflow_runs ?? []).toSorted((a, b) => attemptTime(b) - attemptTime(a) || b.id - a.id);
  for (const r of runs) {
    if (r.status !== 'completed') return unknown(`deploy run ${r.id} is ${r.status}`);
    let inputs;
    try { inputs = await deployRunInputs(r.id, { gh, attempt: r.run_attempt ?? 1 }); } catch (e) { return unknown(`newer deploy run ${r.id} unreadable: ${e.message}`); }
    if (inputs.none) continue;
    if (inputs.binary !== binary) continue;
    if (inputs.env !== env) return unknown(`deploy run ${r.id} targeted ${inputs.env}`);
    if (r.conclusion !== 'success' || inputs.partial) return unknown(`latest ${binary} deploy run ${r.id} ended ${r.conclusion}`);
    return { state: 'known', ...inputs, run: String(r.id), attempt: r.run_attempt, at: r.run_started_at };
  }
  return { state: 'none', why: `no ${binary} deploy among the last ${runs.length} runs` };
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

// Pure classification of a service release from its Release run and the downstream deploy run.
export function classify({ release, downstream, downstreamJobs, inputs, expect, releaseAgeSec, waitSec = 1800 }) {
  if (!release || release.status !== 'completed') return { state: 'running', why: 'release run not finished' };
  if (release.conclusion !== 'success') return { state: 'failed', failure: `release run ${release.conclusion}` };
  if (!downstream) return releaseAgeSec > waitSec
    ? { state: 'built_not_deployed', failure: 'release ok, no downstream deploy run' } : { state: 'running', why: 'downstream not found yet' };
  if (!isWorkflow(downstream, DEVOPS_WORKFLOW)) return unknown(`run ${downstream.id} is not ${DEVOPS_WORKFLOW}`);
  if (downstream.status !== 'completed') return { state: 'running', why: 'downstream running' };
  if (downstream.conclusion === 'cancelled' && !downstreamJobs)
    return { state: 'built_not_deployed', failure: `release ok, downstream ${downstream.id} cancelled before any job` };
  if (downstream.conclusion !== 'success') return { state: 'failed', failure: `downstream ${downstream.id} ${downstream.conclusion}` };
  if (!inputs) return unknown(`downstream ${downstream.id} inputs unreadable`);
  for (const k of ['env', 'binary', 'git_sha']) if (!expect[k]) return unknown(`release has no ${k} bound`);
  for (const k of ['env', 'binary', 'tag', 'digest', 'git_sha'])
    if (expect[k] && inputs[k] !== expect[k]) return { state: 'failed', failure: `downstream deployed ${k}=${inputs[k]}, expected ${expect[k]}` };
  return { state: 'done', digest: inputs.digest };
}

// Terraform / migration: the recorded run must be the right workflow, environment and plan, and its apply step must have run.
export async function observeMutation(r, { gh = ghText } = {}) {
  const rule = EXEC_RULES[r.kind];
  const id = rule?.identity(r.plan_id);
  if (!id) return unknown(`plan_id ${r.plan_id} has no recognised ${r.kind} format`);
  if (!r.tf_run) return unknown('no mutation run recorded');
  const info = await runInfo(DEVOPS, r.tf_run, { gh });
  if (!isWorkflow(info, rule.workflow)) return unknown(`run ${r.tf_run} is ${info?.path}, not ${rule.workflow}`);
  if (info.status !== 'completed') return { state: 'running', why: `run ${r.tf_run} ${info.status}` };
  let jobs;
  try { jobs = await runJobs(gh, DEVOPS, r.tf_run); } catch (e) { return unknown(`run ${r.tf_run} logs unreadable: ${e.message}`); }
  const envs = [...jobs.log.matchAll(/\bCRPKO_ENV: (\S+)/g)].map(m => m[1]);
  if (!envs.length || envs.some(e => e !== r.environment)) return unknown(`run ${r.tf_run} environment ${[...new Set(envs)].join(',') || 'not shown'}, expected ${r.environment}`);
  const missing = id.lines.filter(l => !jobs.log.includes(l));
  if (missing.length) return unknown(`run ${r.tf_run} does not show ${missing.join('; ')}`);
  const step = jobs.jobs.flatMap(j => j.steps ?? []).find(s => s.name === id.step);
  const readback = { run: info.html_url, attempt: info.run_attempt, step: id.step, step_conclusion: step?.conclusion ?? null };
  if (info.conclusion === 'success' && step?.conclusion === 'success') return { state: 'done', readback };
  return { state: 'failed', failure: `run ${info.conclusion}, step "${id.step}" ${step?.conclusion ?? 'absent'}`, readback };
}

// Observer for coord.releaseObserve. Returns {state: running|unknown|done|failed|built_not_deployed, ...}.
export async function observeRelease(r, { gh = ghText, now = Math.floor(Date.now() / 1000) } = {}) {
  requireEnv(r.environment);
  if (EXEC_RULES[r.kind]) return observeMutation(r, { gh });
  if (r.kind === 'frontend_release') {
    if (!r.deploy_run) return { state: 'running', why: 'no deploy run recorded' };
    const d = await runInfo(r.repo, r.deploy_run, { gh });
    if (d.status !== 'completed') return { state: 'running', why: 'deploy run not finished' };
    if (d.conclusion !== 'success') return { state: 'failed', failure: `deploy run ${d.conclusion}` };
    if (d.head_branch !== BRANCH) return unknown(`deploy run ${d.id} ran on ${d.head_branch}, not ${BRANCH}`);
    let ok;
    try { ok = await contains(r.repo, r.git_sha, d.head_sha, { gh }); } catch (e) { return unknown(`compare failed: ${e.message}`); }
    const readback = { observed_head: d.head_sha, run: d.html_url };
    return ok ? { state: 'done', readback, outcome: d.head_sha === r.git_sha ? 'done' : `done at observed ${d.head_sha}` }
      : { state: 'failed', failure: `observed ${d.head_sha} does not contain requested ${r.git_sha}`, readback };
  }
  const expect = { env: r.environment, binary: r.binary, tag: r.tag, digest: r.image_digest, git_sha: r.git_sha };
  const release = r.kind === 'redispatch' ? { status: 'completed', conclusion: 'success' } : r.release_run ? await runInfo(r.repo, r.release_run, { gh }) : null;
  let downstreamId = r.deploy_run;
  if (!downstreamId && release?.conclusion === 'success' && r.release_run) {
    let log;
    try { ({ log } = await runJobs(gh, r.repo, r.release_run)); } catch (e) { return unknown(`release run logs unreadable: ${e.message}`); }
    downstreamId = /crpko-devops\/actions\/runs\/(\d+)/.exec(log)?.[1];
  }
  const downstream = downstreamId ? await runInfo(DEVOPS, downstreamId, { gh }) : null;
  const finished = downstream?.status === 'completed';
  const jobs = finished ? (await runJobs(gh, DEVOPS, downstreamId, { logs: false })).count : 0;
  let inputs = null;
  if (finished && downstream.conclusion === 'success') {
    try { inputs = await deployRunInputs(downstreamId, { gh, attempt: downstream.run_attempt ?? 1 }); } catch (e) { return unknown(`downstream ${downstreamId} inputs unreadable: ${e.message}`); }
    if (inputs.none || inputs.partial) inputs = null;
  }
  const age = release?.updated_at ? now - Math.floor(Date.parse(release.updated_at) / 1000) : now - (r.updated_at ?? now);
  const c = classify({ release, downstream, downstreamJobs: jobs, inputs, expect, releaseAgeSec: age });
  return { ...c, readback: { release_run: r.release_run, deploy_run: downstreamId ?? null, inputs } };
}

// Evaluator for coord.ready: pr_merged / pr_deployed refs look like `owner/repo#123` or `owner/repo#123@binary`.
export async function external(dep, { gh = ghText } = {}) {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)(?:@([\w-]+))?$/.exec(dep.ref);
  if (!m) return { state: 'waiting', why: 'ref must be owner/repo#N[@binary]' };
  const pr = await ghJson(gh, ['pr', 'view', m[2], '--repo', m[1], '--json', 'state,mergeCommit']);
  if (pr?.state !== 'MERGED') return { state: 'waiting', why: `PR ${pr?.state ?? 'unknown'}` };
  const sha = pr.mergeCommit?.oid;
  if (dep.need === 'pr_merged') return { state: 'ready', why: 'merged', evidence: sha };
  const binary = m[3] ?? m[1].split('/')[1];
  const rt = await serviceRuntime({ binary, gh });
  if (rt.state !== 'known') return { state: 'waiting', why: rt.why };
  return (await contains(m[1], sha, rt.git_sha, { gh }))
    ? { state: 'ready', why: `in running ${binary} ${rt.tag}`, evidence: `run ${rt.run} attempt ${rt.attempt} ${rt.digest}` }
    : { state: 'waiting', why: `not in running ${binary} ${rt.tag} (run ${rt.run})` };
}

// Revision-specific deploy evidence from GitHub. Read-only: it only runs `gh` queries.
import { execFile } from 'node:child_process';
import { get, run } from './db.mjs';

export const DEVOPS = 'Equicom-Crypto/crpko-devops';
export const DEVOPS_WORKFLOW = 'deploy-dev-service.yml';
export const BRANCH = process.env.COORD_DEPLOY_BRANCH || 'main-dev';

export function ghText(args, { timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout, maxBuffer: 256 * 1024 * 1024 }, (err, out, stderr) =>
      err ? reject(new Error(`gh ${args.slice(0, 3).join(' ')}: ${(stderr || err.message).trim().slice(0, 300)}`)) : resolve(out));
  });
}
const ghJson = async (gh, args) => JSON.parse((await gh(args)) || 'null');

// The deploy workflow validates its inputs in two log lines; both must agree on the binary.
export function parseRunInputs(log) {
  const tag = /validate:release-tag -- --env dev --binary "([\w-]+)" --tag "([\w.-]+)"/.exec(log);
  const img = /validate:ecr-image-provenance --\s+--env dev\s+--binary "([\w-]+)"\s+--image-digest "(sha256:[0-9a-f]{64})"\s+--git-sha "([0-9a-f]{40})"/.exec(log);
  if (!tag || !img || tag[1] !== img[1]) return null;
  return { binary: tag[1], tag: tag[2], digest: img[2], git_sha: img[3] };
}

async function runLog(gh, repo, id) {
  const jobs = await ghJson(gh, ['api', `repos/${repo}/actions/runs/${id}/jobs?per_page=100`]);
  let log = '';
  for (const j of jobs?.jobs ?? []) log += await gh(['api', `repos/${repo}/actions/jobs/${j.id}/logs`]).catch(() => '');
  return { log, jobs: jobs?.total_count ?? (jobs?.jobs ?? []).length };
}

// Inputs of a deploy run, cached per run id because the logs are large.
export async function deployRunInputs(id, { gh = ghText } = {}) {
  const hit = get('SELECT inputs FROM run_inputs WHERE run_id=?', String(id));
  if (hit) return JSON.parse(hit.inputs);
  const { log } = await runLog(gh, DEVOPS, id);
  const inputs = parseRunInputs(log);
  // Only parsed inputs are cached: an empty log may be a transient fetch failure.
  if (inputs) run('INSERT OR REPLACE INTO run_inputs (run_id,inputs,at) VALUES (?,?,?)', String(id), JSON.stringify(inputs), Math.floor(Date.now() / 1000));
  return inputs;
}

// What is live for a binary: the newest successful deploy-dev-service run whose validated inputs name it.
export async function serviceRuntime({ binary, limit = 40, gh = ghText } = {}) {
  const runs = await ghJson(gh, ['run', 'list', '--repo', DEVOPS, '--workflow', DEVOPS_WORKFLOW, '--status', 'success',
    '--limit', String(limit), '--json', 'databaseId,createdAt,conclusion']);
  for (const r of (runs ?? []).toSorted((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))) {
    if (r.conclusion && r.conclusion !== 'success') continue;
    const inputs = await deployRunInputs(r.databaseId, { gh });
    if (inputs?.binary === binary) return { ...inputs, run: String(r.databaseId), at: r.createdAt };
  }
  return null;
}

// True when `sha` is contained in `head` (identical, or head is ahead of it).
export async function contains(repo, sha, head, { gh = ghText } = {}) {
  const c = await ghJson(gh, ['api', `repos/${repo}/compare/${sha}...${head}`, '--jq', '{status: .status}']);
  return c?.status === 'identical' || c?.status === 'ahead';
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
  if (downstream.status !== 'completed') return { state: 'running', why: 'downstream running' };
  if (downstream.conclusion === 'cancelled' && !downstreamJobs)
    return { state: 'built_not_deployed', failure: `release ok, downstream ${downstream.databaseId} cancelled before any job` };
  if (downstream.conclusion !== 'success') return { state: 'failed', failure: `downstream ${downstream.databaseId} ${downstream.conclusion}` };
  if (!inputs) return { state: 'failed', failure: `downstream ${downstream.databaseId} inputs unreadable` };
  for (const k of ['binary', 'tag', 'digest', 'git_sha'])
    if (expect[k] && inputs[k] !== expect[k]) return { state: 'failed', failure: `downstream deployed ${k}=${inputs[k]}, expected ${expect[k]}` };
  return { state: 'done', digest: inputs.digest };
}

const runView = (gh, repo, id) => ghJson(gh, ['run', 'view', String(id), '--repo', repo, '--json', 'databaseId,status,conclusion,updatedAt,createdAt,url']);

// Observer for coord.releaseObserve. Services and redispatches; TF/DDL use the recorded tf_run conclusion.
export async function observeRelease(r, { gh = ghText, now = Math.floor(Date.now() / 1000) } = {}) {
  if (['tf_apply', 'ddl', 'migration'].includes(r.kind)) {
    if (!r.tf_run) return { state: 'running', why: 'no tf run recorded' };
    const t = await runView(gh, DEVOPS, r.tf_run);
    if (t.status !== 'completed') return { state: 'running', why: 'tf run not finished' };
    return t.conclusion === 'success' ? { state: 'done', readback: { tf_run: t.url } } : { state: 'failed', failure: `tf run ${t.conclusion}`, readback: { tf_run: t.url } };
  }
  if (r.kind === 'frontend_release') {
    if (!r.deploy_run) return { state: 'running', why: 'no deploy run recorded' };
    const d = await ghJson(gh, ['run', 'view', String(r.deploy_run), '--repo', r.repo, '--json', 'status,conclusion,headSha,url']);
    if (d.status !== 'completed') return { state: 'running', why: 'deploy run not finished' };
    if (d.conclusion !== 'success') return { state: 'failed', failure: `deploy run ${d.conclusion}` };
    return { state: 'done', readback: { observed_head: d.headSha, run: d.url }, outcome: d.headSha === r.git_sha ? 'done' : `done at observed ${d.headSha}` };
  }
  const expect = { binary: r.binary, tag: r.tag, digest: r.image_digest, git_sha: r.git_sha };
  let release = r.kind === 'redispatch' ? { status: 'completed', conclusion: 'success' } : r.release_run ? await runView(gh, r.repo, r.release_run) : null;
  let downstreamId = r.deploy_run;
  if (!downstreamId && release?.conclusion === 'success' && r.release_run) {
    const { log } = await runLog(gh, r.repo, r.release_run);
    downstreamId = /crpko-devops\/actions\/runs\/(\d+)/.exec(log)?.[1];
  }
  const downstream = downstreamId ? await runView(gh, DEVOPS, downstreamId) : null;
  const finished = downstream?.status === 'completed';
  const jobs = finished ? (await ghJson(gh, ['api', `repos/${DEVOPS}/actions/runs/${downstreamId}/jobs?per_page=1`]))?.total_count ?? 0 : 0;
  const inputs = finished && downstream.conclusion === 'success' ? await deployRunInputs(downstreamId, { gh }) : null;
  const age = release?.updatedAt ? now - Math.floor(Date.parse(release.updatedAt) / 1000) : now - (r.updated_at ?? now);
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
  if (!rt) return { state: 'waiting', why: `no successful deploy run for ${binary}` };
  return (await contains(m[1], sha, rt.git_sha, { gh }))
    ? { state: 'ready', why: `in running ${binary} ${rt.tag}`, evidence: `run ${rt.run} ${rt.digest}` }
    : { state: 'waiting', why: `not in running ${binary} ${rt.tag} (run ${rt.run})` };
}

import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as C from '../lib/coord.mjs';

export const tmp = () => mkdtempSync(join(tmpdir(), 'coord-test-'));

let t0 = 1_800_000_000;
export function fresh() {
  const dir = tmp();
  C.open(join(dir, 'coord.db'));
  t0 = 1_800_000_000;
  C.clock.now = () => t0;
  return join(dir, 'coord.db');
}
export const advance = s => { t0 += s; };

// Stand-in for the Robob control API. Like Robob, a repeated clientRequestId replays the first result.
export async function stubControl({ states = {} } = {}) {
  const sends = [];
  const byRequest = new Map();
  const messages = {};
  let failNext = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== 'Bearer test-token') return reply(401, { ok: false, error: { code: 'unauthorized', message: 'no' } });
      const m = /^\/api\/ardud\/control\/threads\/([^/]+)(\/send)?$/.exec(req.url);
      if (!m) return reply(404, { ok: false, error: { code: 'not_found', message: req.url } });
      const thread = decodeURIComponent(m[1]);
      if (!(thread in states)) return reply(404, { ok: false, error: { code: 'not_found', message: `no thread ${thread}` } });
      if (!m[2]) return reply(200, { ok: true, thread: { threadId: thread, state: states[thread] } });
      const body = JSON.parse(raw);
      sends.push({ thread, ...body });
      if (failNext > 0) { failNext--; return reply(503, { ok: false, error: { code: 'unavailable', message: 'down' } }); }
      const id = `ardud-control:send:${thread}:${encodeURIComponent(body.clientRequestId)}`;
      if (!byRequest.has(id)) {
        const delivery = states[thread] === 'running' && body.mode === 'queue' ? 'queued' : 'started';
        byRequest.set(id, { messageId: id, runId: `run-${byRequest.size + 1}`, delivery });
        (messages[thread] ??= []).push({ messageId: id, text: body.text });
      }
      reply(200, { ok: true, threadId: thread, ...byRequest.get(id) });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const cfg = { url: `http://127.0.0.1:${server.address().port}`, token: 'test-token' };
  return { cfg, sends, messages, states, failNext: n => { failNext = n; }, close: () => new Promise(r => server.close(r)) };
}

export const SHA0 = '0'.repeat(40);
export const SHA1 = 'a'.repeat(40);
export const SHA2 = 'b'.repeat(40);
export const DIGEST = `sha256:${'c'.repeat(64)}`;

// Rollout-gate hook that clears every PR in the range with evidence.
export const gatesOk = async r => ({ prs: r.content_prs.map(pr => ({ pr, ok: true, evidence: `approved head of ${pr}` })) });

// Fake `gh` keyed by the joined argument string. Values may be strings, objects (JSON) or functions.
export function fakeGh(routes) {
  const calls = [];
  const gh = async args => {
    const k = args.join(' ');
    calls.push(k);
    for (const [re, v] of routes) {
      const m = k.match(re);
      if (!m) continue;
      const out = typeof v === 'function' ? await v(m) : v;
      return typeof out === 'string' ? out : JSON.stringify(out);
    }
    throw new Error(`fake gh: no route for ${k}`);
  };
  gh.calls = calls;
  return gh;
}

export const deployLog = (binary, tag, sha, { env = 'dev', digest = DIGEST } = {}) =>
  `npm run validate:release-tag -- --env ${env} --binary "${binary}" --tag "${tag}"\n` +
  `npm run validate:ecr-image-provenance -- --env ${env} --binary "${binary}" --image-digest "${digest}" --git-sha "${sha}" --aws-account-id "1"`;

// Release hooks for tests: runtime is whatever `live` says (default SHA0 for every binary), the range of
// base..head is `ranges[head]` (default the request's own list), and every PR clears its gates.
export const live = {};
export const ranges = {};
export const testHooks = {
  runtime: async r => ({ state: 'known', sha: live[r.binary] ?? SHA0, run: '1', attempt: 1 }),
  rangeResolver: async ({ base, head }) => ({ complete: true, prs: ranges[`${base}..${head}`] ?? ranges[head] ?? ['equicom-crypto/trading-core#141'], evidence: `compare ${base}...${head}` }),
  gateCheck: async r => ({ prs: r.content_prs.map(pr => ({ pr, ok: true, evidence: `approved head of ${pr}` })) }),
};
export function resetHooks() {
  for (const k of Object.keys(live)) delete live[k];
  for (const k of Object.keys(ranges)) delete ranges[k];
  C.configure?.(testHooks);
}

// Fake GitHub for runtime discovery. `runs` per workflow file: [{ id, attempt?, started, created?, conclusion?,
// status?, log?, jobs? }]; `log` is the deploy log of that attempt (an Error to make it unreadable).
export function deployGh(byWorkflow, { repo = 'equicom-crypto/crpko-devops', perPage = 100, extra = [] } = {}) {
  const runs = Object.values(byWorkflow).flat();
  const shapeRun = r => ({ id: r.id, status: r.status ?? 'completed', conclusion: r.conclusion ?? 'success', run_attempt: r.attempt ?? 1,
    created_at: r.created ?? r.started, run_started_at: r.started, head_sha: r.head, head_branch: r.branch ?? 'main-dev', path: r.path });
  return fakeGh([
    ...extra,
    [new RegExp(`repos/${repo}/actions/workflows/([\\w.-]+)/runs\\?per_page=100&page=(\\d+)`), m => {
      const list = (byWorkflow[m[1]] ?? []).toSorted((a, b) => Date.parse(b.created ?? b.started) - Date.parse(a.created ?? a.started) || b.id - a.id);
      return { workflow_runs: list.slice((m[2] - 1) * perPage, m[2] * perPage).map(shapeRun) };
    }],
    [/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs/, m => {
      const r = runs.find(x => x.id === Number(m[1]));
      return { total_count: (r.jobs ?? [{}]).length, jobs: (r.jobs ?? [{ name: 'deploy' }]).map((j, i) => ({ id: r.id * 100 + i, status: 'completed', conclusion: 'success',
        run_attempt: Number(m[2]), steps: [{ name: 'Validate release tag', conclusion: 'success' }], ...j })) };
    }],
    [/actions\/jobs\/(\d+)\/logs/, m => {
      const r = runs.find(x => x.id === Math.floor(Number(m[1]) / 100));
      const j = (r.jobs ?? [{}])[Number(m[1]) % 100];
      if (j.log instanceof Error) throw j.log;
      if (j.log !== undefined) return j.log;
      if (r.log instanceof Error) throw r.log;
      return r.log ?? '';
    }],
    [/actions\/runs\/(\d+)$/, m => shapeRun(runs.find(x => x.id === Number(m[1])))],
  ]);
}

// A valid release tag for a binary/env: <binary>-docs1-<env>.<n>.
export const tagFor = (binary = 'trading-core', n = 33, env = 'dev') => `${String(binary).toLowerCase()}-docs1-${env}.${n}`;

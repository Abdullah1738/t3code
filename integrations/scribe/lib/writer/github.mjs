// Merged PRs, release runs and docs commits from GitHub (read-only gh calls).
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { areaOf } from './config.mjs';
import { expand } from './scrub.mjs';
import { execJson, execLines, mapLimit } from './sh.mjs';

const BODY_MAX = 600;

const inWindow = (iso, from, to) => {
  const at = Date.parse(iso);
  return at >= Date.parse(from) && at < Date.parse(to);
};

const ticketRe = (prefixes) => (prefixes.length ? new RegExp(`\\b(?:${prefixes.join('|')})-\\d+\\b`, 'g') : null);

/** Ticket ids (e.g. CRP-123) in a title and body, title first. */
export function ticketsIn(config, ...texts) {
  const re = ticketRe(config.ticketPrefixes);
  if (!re) return [];
  const out = [];
  for (const text of texts) for (const match of String(text ?? '').matchAll(re)) if (!out.includes(match[0])) out.push(match[0]);
  return out;
}

/** Trims a PR body to its first paragraphs: no HTML comments, checklists or images. */
export function excerpt(body, max = BODY_MAX) {
  const text = String(body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .split('\n')
    .filter((line) => !/^\s*[-*]\s+\[[ xX]\]/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;
}

/** PRs merged in [from, to) across the mission's GitHub owner, skipped repos dropped. */
export async function mergedPrs({ config, from, to, exec }) {
  const { owner, ours, skipRepos } = config.github;
  const rows = await execJson(exec, 'gh', [
    'search',
    'prs',
    '--owner',
    owner,
    '--merged-at',
    `${from}..${to}`,
    '--limit',
    '1000',
    '--json',
    'number,repository,title,author,closedAt,url,body',
  ]);
  if (rows.length >= 1000) throw new Error('gh search returned 1000 PRs, the search cap; narrow the window');
  return rows
    .filter((row) => inWindow(row.closedAt, from, to) && !skipRepos.includes(row.repository.name))
    .map((row) => {
      const repo = row.repository.name;
      const login = row.author?.login ?? 'unknown';
      const isOurs = ours.includes(login);
      return {
        ref: `${repo}#${row.number}`,
        repo,
        number: row.number,
        title: row.title,
        author: login,
        person: isOurs ? 'us' : config.people[login] || login,
        ours: isOurs,
        mergedAt: row.closedAt,
        url: row.url,
        area: areaOf(config, { repo }),
        tickets: ticketsIn(config, row.title, row.body),
        body: expand(excerpt(row.body), config.aliases),
      };
    })
    .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
}

/** Commits in [from, to) on a docs repo's branch, oldest first. */
export async function docsCommits({ doc, from, to, exec }) {
  const rows = await execLines(exec, 'gh', [
    'api',
    '--paginate',
    `repos/${doc.repo}/commits?sha=${encodeURIComponent(doc.branch)}&since=${from}&until=${to}&per_page=100`,
    '--jq',
    '.[] | {at: .commit.committer.date, subject: (.commit.message | split("\\n")[0])}',
  ]);
  return rows.filter((row) => inWindow(row.at, from, to)).sort((a, b) => a.at.localeCompare(b.at));
}

// Release tags sort by their numeric groups in order.
const tagKey = (match) => match.slice(1).filter((group) => group !== undefined && /^\d+$/.test(group)).map(Number);
const compareKeys = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1);
    if (diff) return diff;
  }
  return 0;
};

/** The highest tag of the same service below `tag`, or null. */
export function previousTag(config, tag, tags) {
  const pattern = config.releases.tagPattern;
  const match = pattern.exec(tag);
  if (!match) return null;
  const service = match.groups?.service;
  const key = tagKey(match);
  let best = null;
  for (const candidate of tags) {
    const other = pattern.exec(candidate);
    if (!other || other.groups?.service !== service) continue;
    const otherKey = tagKey(other);
    if (compareKeys(otherKey, key) >= 0) continue;
    if (!best || compareKeys(otherKey, best.key) > 0) best = { tag: candidate, key: otherKey };
  }
  return best?.tag ?? null;
}

const findFile = (dir, re) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      const found = findFile(path, re);
      if (found) return found;
    } else if (re.test(name)) return path;
  }
  return null;
};

const readJson = (path) => {
  try {
    return path ? JSON.parse(readFileSync(path, 'utf8')) : null;
  } catch {
    return null;
  }
};

/** Release evidence a run uploaded: tag, binary, outcome and runtime checks. */
/** Names of the runtime checks that found something; the inventory lists every check, most with nothing. */
export function failingChecks(failures) {
  if (!failures || typeof failures !== 'object') return [];
  const found = (value) => (Array.isArray(value) ? value.length > 0 : value && typeof value === 'object' ? Object.keys(value).length > 0 : Boolean(value));
  return Object.entries(failures)
    .filter(([, value]) => found(value))
    .map(([name]) => name)
    .slice(0, 10);
}

async function runEvidence({ config, runId, exec }) {
  const dir = mkdtempSync(join(tmpdir(), 'scribe-release-'));
  try {
    await exec('gh', ['run', 'download', String(runId), '-R', config.releases.repo, '-D', dir], { timeoutMs: 120_000 });
    const manifest = readJson(findFile(dir, /^manifest\.json$/));
    const inventory = readJson(findFile(dir, /^runtime-inventory.*\.json$/));
    return {
      tag: manifest?.release_tag ?? null,
      binary: manifest?.binary ?? null,
      outcome: manifest?.outcome ?? null,
      runtimeChecked: inventory ? Boolean(inventory.passed) : null,
      runtimeFailures: failingChecks(inventory?.runtime_surface?.failures),
    };
  } catch (error) {
    return { tag: null, binary: null, outcome: null, runtimeChecked: null, runtimeFailures: [], error: error.message.slice(0, 200) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** PR refs a release carried since the previous tag (from "(#N)" in commit subjects). */
async function carried({ config, repo, prev, tag, exec }) {
  const owner = config.github.owner;
  const subjects = await execJson(exec, 'gh', [
    'api',
    `repos/${owner}/${repo}/compare/${encodeURIComponent(prev)}...${encodeURIComponent(tag)}`,
    '--jq',
    '[.commits[].commit.message | split("\\n")[0]]',
  ]);
  const refs = [];
  for (const subject of subjects) {
    const match = /\(#(\d+)\)\s*$/.exec(subject) ?? /#(\d+)\b/.exec(subject);
    if (match && !refs.includes(`${repo}#${match[1]}`)) refs.push(`${repo}#${match[1]}`);
  }
  return { refs, commits: subjects.length };
}

/** Release runs in [from, to) with their tag, the previous tag and the PRs carried. */
export async function releases({ config, from, to, exec, log = () => {} }) {
  const { repo, workflow, serviceRepos } = config.releases;
  const runs = await execJson(exec, 'gh', [
    'run',
    'list',
    '-R',
    repo,
    '-w',
    workflow,
    '--created',
    `${from}..${to}`,
    '--limit',
    '300',
    '--json',
    'databaseId,conclusion,status,createdAt,updatedAt,event',
  ]);
  const tagCache = new Map();
  const tagsOf = async (serviceRepo, prefix) => {
    const key = `${serviceRepo}|${prefix}`;
    if (!tagCache.has(key)) {
      tagCache.set(
        key,
        execLines(exec, 'gh', [
          'api',
          '--paginate',
          `repos/${config.github.owner}/${serviceRepo}/git/matching-refs/tags/${prefix}`,
          '--jq',
          '.[].ref | sub("^refs/tags/"; "") | tojson',
        ]),
      );
    }
    return tagCache.get(key);
  };
  const sorted = runs.filter((run) => inWindow(run.createdAt, from, to)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return mapLimit(sorted, 4, async (run) => {
    const evidence = await runEvidence({ config, runId: run.databaseId, exec });
    const service = evidence.tag ? config.releases.tagPattern.exec(evidence.tag)?.groups?.service ?? evidence.binary : evidence.binary;
    const serviceRepo = service ? serviceRepos[service] || service : null;
    let prev = null;
    let carry = { refs: [], commits: 0 };
    // Known only when the previous tag was found and the comparison came
    // back; a failed lookup says nothing about what the run carried.
    let carriedKnown = false;
    let carryError = null;
    if (evidence.tag && serviceRepo && run.conclusion === 'success') {
      try {
        prev = previousTag(config, evidence.tag, await tagsOf(serviceRepo, service));
        if (prev) {
          carry = await carried({ config, repo: serviceRepo, prev, tag: evidence.tag, exec });
          carriedKnown = true;
        }
      } catch (error) {
        carryError = error.message.slice(0, 200);
        log(`release ${evidence.tag}: carried PRs unknown (${error.message.slice(0, 120)})`);
      }
    }
    return {
      at: run.createdAt,
      conclusion: run.conclusion || run.status,
      tag: evidence.tag,
      service,
      repo: serviceRepo,
      previousTag: prev,
      carried: carry.refs,
      commits: carry.commits,
      carriedKnown,
      ...(carryError ? { carryError } : {}),
      runtimeChecked: evidence.runtimeChecked,
      runtimeFailures: evidence.runtimeFailures,
      ...(evidence.error ? { evidenceError: evidence.error } : {}),
    };
  });
}

/** Runs of the release repo's other workflows in [from, to), counted per workflow. */
export async function workflowCounts({ config, repo, from, to, exec, filter = () => true }) {
  const runs = await execJson(exec, 'gh', [
    'run',
    'list',
    '-R',
    repo,
    '--created',
    `${from}..${to}`,
    '--limit',
    '1000',
    '--json',
    'workflowName,conclusion,status,event,createdAt',
  ]);
  const counts = new Map();
  for (const run of runs) {
    if (!inWindow(run.createdAt, from, to) || !filter(run)) continue;
    const key = run.workflowName;
    const entry = counts.get(key) ?? { workflow: key, runs: 0, success: 0, failure: 0, other: 0, last: null };
    entry.runs++;
    if (run.conclusion === 'success') entry.success++;
    else if (run.conclusion === 'failure') entry.failure++;
    else entry.other++;
    if (!entry.last || run.createdAt > entry.last) entry.last = run.createdAt;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.runs - a.runs);
}

export { inWindow };

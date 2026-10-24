// Review decisions and deploy records from the review workflow's DB (read-only).
import { DatabaseSync } from 'node:sqlite';
import { expand, redact, scrub } from './scrub.mjs';

const seconds = (iso) => Math.floor(Date.parse(iso) / 1000);
const iso = (epochSeconds) => new Date(Number(epochSeconds) * 1000).toISOString();

// 'Owner/repo#12' -> 'repo#12'
const shortRef = (key) => String(key).replace(/^[^/]+\//, '');

const parseList = (text) => {
  try {
    const value = JSON.parse(text ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

export function openCrw(path) {
  return new DatabaseSync(path, { readOnly: true });
}

/**
 * Review decisions made in [from, to): every decision row created in the
 * window, newest round per PR last. The workflow only reviews the team's PRs,
 * so no author filter beyond dropping ours.
 */
export function reviews(db, { config, from, to }) {
  const ours = new Set(config.github?.ours ?? []);
  const rows = db
    .prepare(
      `select d.id, d.pr_key, d.verdict, d.status, d.stage, d.summary, d.created_at,
              p.author, p.title, p.state, p.merged_at
         from decisions d left join prs p on p.key = d.pr_key
        where d.created_at >= ? and d.created_at < ?
        order by d.created_at, d.id`,
    )
    .all(seconds(from), seconds(to));
  return rows
    .filter((row) => !ours.has(row.author))
    .map((row) => ({
      at: iso(row.created_at),
      ref: shortRef(row.pr_key),
      author: row.author ?? null,
      person: row.author ? config.people[row.author] || row.author : null,
      title: row.title ?? null,
      verdict: row.verdict || 'No verdict',
      state: row.status,
      gist: scrub(expand(row.summary ?? '', config.aliases), config.banned, 300),
      prState: row.state ?? null,
    }));
}

/** Which of `refs` ('repo#12') the workflow ever made a decision on, up to `to`. */
export function reviewedRefs(db, { config, refs, to }) {
  const owner = config.github?.owner;
  const seen = new Set();
  if (!owner || !refs.length) return seen;
  const query = db.prepare('select 1 from decisions where pr_key = ? and created_at < ? limit 1');
  for (const ref of refs) if (query.get(`${owner}/${ref}`, seconds(to))) seen.add(ref);
  return seen;
}

/** Deploy records the workflow touched in [from, to). */
export function deploys(db, { config, from, to }) {
  const rows = db
    .prepare(
      `select id, repo, status, prs, ref, conclusion, observe_state, failure, created_at, updated_at
         from deploys
        where updated_at >= ? and updated_at < ?
        order by updated_at, id`,
    )
    .all(seconds(from), seconds(to));
  return rows.map((row) => ({
    at: iso(row.updated_at),
    repo: shortRef(row.repo),
    status: row.status,
    tag: row.ref && !['manual', 'main-dev'].includes(row.ref) ? row.ref : null,
    prs: parseList(row.prs).map(shortRef),
    outcome: scrub(expand(row.conclusion ?? '', config.aliases), config.banned, 240),
    // One line: a read back can span lines in the DB.
    observed: row.observe_state ? redact(expand(String(row.observe_state), config.aliases), config.banned).replace(/\s+/g, ' ').trim().slice(0, 240) || null : null,
    failure: scrub(expand(row.failure ?? '', config.aliases), config.banned, 240),
  }));
}

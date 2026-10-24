// Commits that landed on a branch, for missions whose work is a git repo
// rather than PRs (read-only git log; the writer never fetches).
import { areaOf } from './config.mjs';

const FIELD = '\x1f';
const RECORD = '\x1e';

const inWindow = (iso, from, to) => {
  const at = Date.parse(iso);
  return at >= Date.parse(from) && at < Date.parse(to);
};

/** "feat(scribe): x" -> "scribe"; "robob-watch: x" -> "robob-watch"; else null. */
export function commitScope(subject) {
  const conventional = /^[a-z]+(?:\(([^)]+)\))?!?:\s/.exec(subject);
  if (conventional) return conventional[1] ?? null;
  const loose = /^([a-z0-9][a-z0-9._/-]*):\s/i.exec(subject);
  return loose ? loose[1] : null;
}

/**
 * Non-merge commits on `config.git.ref` committed in [from, to), oldest first,
 * each with its short hash as ref and the area its scope or files fall in.
 */
export async function commits({ config, from, to, exec }) {
  const { dir, ref, ours, exclude } = config.git;
  // --since/--until filter on committer date; slack on both sides, exact window below.
  const out = await exec(
    'git',
    [
      '-C',
      dir,
      'log',
      ref,
      ...exclude.map((other) => `^${other}`),
      '--no-merges',
      `--since=${new Date(Date.parse(from) - 60_000).toISOString()}`,
      `--until=${new Date(Date.parse(to) + 60_000).toISOString()}`,
      '--name-only',
      `--format=${RECORD}%H${FIELD}%cI${FIELD}%an${FIELD}%ae${FIELD}%s${FIELD}%b${FIELD}`,
    ],
    { timeoutMs: 60_000 },
  );
  const units = [];
  for (const chunk of out.split(RECORD)) {
    if (!chunk.trim()) continue;
    const [hash, committedAt, name, email, subject, body, rest] = chunk.split(FIELD);
    if (!inWindow(committedAt, from, to)) continue;
    const files = (rest ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
    const scope = commitScope(subject);
    const isOurs = !ours.length || ours.includes(name) || ours.includes(email);
    units.push({
      // Ten hex digits: the citation check reads commit refs at exactly this length.
      ref: hash.trim().slice(0, 10),
      repo: null,
      number: null,
      title: subject,
      author: name,
      person: isOurs ? 'us' : config.people[name] || config.people[email] || name,
      ours: isOurs,
      mergedAt: new Date(committedAt).toISOString(),
      url: null,
      area: areaOf(config, { scope, files }),
      scope,
      files: files.length,
      tickets: [],
      body: String(body ?? '').trim().slice(0, 600),
    });
  }
  return units.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
}

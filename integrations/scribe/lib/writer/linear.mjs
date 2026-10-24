// Ticket titles, parents and triage moves from Linear (read-only linctl graphql).
import { execJson } from './sh.mjs';

const query = async (exec, text) => {
  const out = await execJson(exec, 'linctl', ['graphql', text], { timeoutMs: 60_000 });
  if (out.errors?.length) throw new Error(`linear: ${out.errors[0].message}`);
  return out.data ?? out;
};

const CHUNK = 100;

/** Ticket facts by id for `ids` (missing ones are just absent). */
export async function tickets({ config, ids, exec }) {
  const team = config.linear.team;
  const numbers = [...new Set(ids.filter((id) => id.startsWith(`${team}-`)).map((id) => Number(id.slice(team.length + 1))))];
  const out = {};
  for (let i = 0; i < numbers.length; i += CHUNK) {
    const chunk = numbers.slice(i, i + CHUNK);
    const data = await query(
      exec,
      `query { issues(first: ${CHUNK}, filter: {team: {key: {eq: "${team}"}}, number: {in: [${chunk.join(',')}]}}) {
        nodes { identifier title state { name } project { name } parent { identifier title } } } }`,
    );
    for (const node of data.issues.nodes) {
      out[node.identifier] = {
        title: node.title,
        state: node.state?.name ?? null,
        project: node.project?.name ?? null,
        parent: node.parent ? { id: node.parent.identifier, title: node.parent.title } : null,
      };
    }
  }
  return out;
}

const inWindow = (at, from, to) => at >= from && at < to;

const HISTORY = 50;
const HISTORY_FIELDS = 'createdAt fromProject { name } toProject { name } fromState { name } toState { name }';

/**
 * Project and state changes of one ticket back to `from` (history comes
 * newest first; later pages are read until one reaches past `from`).
 */
async function changesSince(exec, node, from) {
  const moves = [];
  const states = [];
  let history = node.history;
  for (;;) {
    for (const entry of history.nodes) {
      const was = entry.fromProject?.name ?? null;
      const now = entry.toProject?.name ?? null;
      if (was !== now) moves.push({ at: entry.createdAt, from: was, to: now });
      if (entry.fromState || entry.toState) states.push({ at: entry.createdAt, from: entry.fromState?.name ?? null, to: entry.toState?.name ?? null });
    }
    const oldest = history.nodes.at(-1)?.createdAt;
    if (!history.pageInfo.hasNextPage || !oldest || oldest < from) break;
    const data = await query(
      exec,
      `query { issue(id: "${node.identifier}") { history(first: ${HISTORY}, after: "${history.pageInfo.endCursor}") {
        pageInfo { hasNextPage endCursor } nodes { ${HISTORY_FIELDS} } } } }`,
    );
    history = data.issue.history;
  }
  const order = (a, b) => a.at.localeCompare(b.at);
  return { moves: moves.sort(order), states: states.sort(order) };
}

/**
 * Tickets that moved into or out of the triage project in [from, to), or were
 * created there in it: the human QA team's queue. Walks every team ticket
 * updated since `from` (a ticket touched again after `to` still counts for
 * the window), and reads where each one was at the window's end.
 */
export async function triageMoves({ config, from, to, exec, maxPages = 20 }) {
  const { team, triageProject } = config.linear;
  if (!triageProject) return [];
  const out = [];
  let after = null;
  for (let page = 0; ; page++) {
    if (page >= maxPages) throw new Error(`linear: more than ${maxPages * 100} tickets updated since ${from}`);
    const data = await query(
      exec,
      `query { issues(first: 100${after ? `, after: "${after}"` : ''}, filter: {team: {key: {eq: "${team}"}}, updatedAt: {gte: "${from}"}, createdAt: {lt: "${to}"}}) {
        pageInfo { hasNextPage endCursor }
        nodes { identifier title createdAt state { name } project { name }
          history(first: ${HISTORY}) { pageInfo { hasNextPage endCursor } nodes { ${HISTORY_FIELDS} } } } } }`,
    );
    for (const node of data.issues.nodes) {
      const { moves: all, states } = await changesSince(exec, node, from);
      const moves = all.filter((move) => inWindow(move.at, from, to) && (move.from === triageProject || move.to === triageProject));
      // Project and state at the window's end: where the first later change started, else where it is now.
      const later = all.find((move) => move.at >= to);
      const project = later ? later.from : (node.project?.name ?? null);
      const laterState = states.find((change) => change.at >= to);
      const state = laterState ? laterState.from : (node.state?.name ?? null);
      // Created in the window and in triage at creation (before any move).
      const first = all.find((move) => move.at >= node.createdAt);
      const startedIn = first ? first.from : project;
      const createdInTriage = inWindow(node.createdAt, from, to) && startedIn === triageProject && !moves.length;
      if (!moves.length && !createdInTriage) continue;
      out.push({
        id: node.identifier,
        title: node.title,
        createdAt: node.createdAt,
        state,
        project,
        moves,
      });
    }
    if (!data.issues.pageInfo.hasNextPage) break;
    after = data.issues.pageInfo.endCursor;
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

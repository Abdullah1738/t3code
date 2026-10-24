// What the mission's own records say about a window: work items that moved,
// owner asks and requests, approvals, drafts, milestones, lane messages and
// the scribe's usage. Read-only on Robob's state DB.
//
// Records hold their current state. A report about a past window needs the
// state at the window's end, so it is rebuilt from the event log, which says
// when each record changed (the log starts 20 Oct 2026; for a record with
// nothing logged the record itself is used). What the log can't tell (a
// blocker list that changed after the end) counts as unknown, never as now.
import { expand, redact, scrub } from './scrub.mjs';

const TRACKED = ['ask', 'owner-request', 'approval', 'suggestion', 'draft', 'milestone', 'work-item'];
const EVENT_PREFIX = { ask: 'ask.', 'owner-request': 'request.', approval: 'approval.', suggestion: 'suggestion.', draft: 'draft.', milestone: 'milestone.', 'work-item': 'work-item.' };

/** Every tracked record of the mission and its event history, for the state as of `to`. */
export function loadState(db, missionId, to) {
  const byKind = new Map(TRACKED.map((kind) => [kind, []]));
  const records = new Map();
  const rows = db
    .prepare(`select kind, id, record_json from ardud_mission_records where mission_id = ? and kind in (${TRACKED.map(() => '?').join(',')})`)
    .all(missionId, ...TRACKED);
  for (const row of rows) {
    const record = JSON.parse(row.record_json).record;
    records.set(`${row.kind}:${row.id}`, record);
    byKind.get(row.kind).push(record);
  }
  const history = new Map();
  const prefixes = Object.values(EVENT_PREFIX);
  const events = db
    .prepare(`select kind, at, event_json from ardud_mission_events where mission_id = ? and (${prefixes.map(() => 'kind like ?').join(' or ')}) order by seq`)
    .all(missionId, ...prefixes.map((prefix) => `${prefix}%`));
  for (const row of events) {
    const event = JSON.parse(row.event_json);
    if (!event.subject?.kind || !event.subject.id) continue;
    const key = `${event.subject.kind}:${event.subject.id}`;
    const list = history.get(key) ?? [];
    // subject.label is the record's title after the event.
    list.push({ kind: row.kind, at: row.at, payload: event.payload ?? null, label: event.subject.label ?? null });
    history.set(key, list);
  }
  return { to, byKind, records, history };
}

const eventsFor = (state, kind, id) => state.history.get(`${kind}:${id}`) ?? [];
const existed = (record, to) => (record.createdAt ?? '') < to;
const within = (at, from, to) => Boolean(at) && at >= from && at < to;

/**
 * Whether a record that opens and closes (an ask, approval, suggestion or
 * draft) was open at the end, from its logged transitions: the last one
 * before the end; failing that, what the first one after the end replaced
 * (a close after the end means it was open, a reopen that it was closed);
 * with nothing logged, the record as it is now, open if its decision came at
 * or after the end. `step(event)` returns {open, status, prior?} for an event
 * that moves the record, else null.
 */
function phaseAt(state, kind, record, step, now) {
  if (!existed(record, state.to)) return { open: false, status: 'not yet opened', closedAt: null, payload: null };
  const list = eventsFor(state, kind, record.id);
  let last = null;
  for (const event of list) {
    if (event.at >= state.to) break;
    const next = step(event);
    if (next) last = { ...next, at: event.at, payload: event.payload };
  }
  if (last) return { open: last.open, status: last.status, closedAt: last.open ? null : last.at, payload: last.open ? null : last.payload };
  const later = list.find((event) => event.at >= state.to && step(event));
  if (later) {
    const next = step(later);
    const prior = next.prior ?? { open: !next.open, status: null };
    // A reopening can say when the earlier close happened; a close at or after the end means open.
    if (!prior.open && prior.closedAt && prior.closedAt >= state.to) return { open: true, status: now.openStatus, closedAt: null, payload: null };
    return { open: prior.open, status: prior.status ?? (prior.open ? 'open' : 'closed'), closedAt: prior.open ? null : (prior.closedAt ?? null), payload: prior.open ? null : (prior.payload ?? null) };
  }
  const closed = now.open ? null : (now.decidedAt ?? record.updatedAt ?? record.createdAt ?? null);
  if (closed === null || closed >= state.to) return { open: true, status: now.openStatus, closedAt: null, payload: null };
  return { open: false, status: record.status, closedAt: closed, payload: null };
}

const ASK_STEPS = {
  'ask.opened': () => ({ open: true, status: 'open' }),
  'ask.answered': () => ({ open: false, status: 'answered', prior: { open: true, status: 'open' } }),
  'ask.withdrawn': () => ({ open: false, status: 'withdrawn', prior: { open: true, status: 'open' } }),
  'ask.superseded': () => ({ open: false, status: 'superseded', prior: { open: true, status: 'open' } }),
  // The reopening carries the answer it set aside.
  'ask.reopened': (payload) => ({
    open: true,
    status: 'open',
    prior: { open: false, status: 'answered', payload: payload.previousAnswer ?? null, closedAt: payload.previousAnswer?.answeredAt ?? null },
  }),
};
const stepper = (steps) => (event) => steps[event.kind]?.(event.payload ?? {}) ?? null;

/** An ask at the end: open, or how it closed (the answer only if given by then). */
export function askAt(state, ask) {
  const phase = phaseAt(state, 'ask', ask, stepper(ASK_STEPS), { open: ask.status === 'open', openStatus: 'open', decidedAt: ask.answer?.answeredAt });
  if (phase.open || phase.status !== 'answered') return { open: phase.open, status: phase.status, answer: null, closedAt: phase.closedAt };
  // The answer the closing event carried, else (closed before the log) the record's.
  const given = phase.payload ?? (phase.closedAt ? ask.answer : null) ?? {};
  const option = ask.options?.find((candidate) => candidate.id === given.optionId);
  return { open: false, status: 'answered', answer: given.text || option?.label || null, closedAt: phase.closedAt };
}

const REQUEST_MOVES = { 'request.opened': 'waiting-on-master', 'request.settled': 'settled', 'request.reopened': 'waiting-on-master' };

/** An owner request at the end. status is null when the log can't tell. */
export function requestAt(state, request) {
  const list = eventsFor(state, 'owner-request', request.id);
  let status = null;
  for (const event of list) {
    if (event.at >= state.to) break;
    if (event.kind === 'request.replied') status = event.payload?.status ?? status;
    else if (REQUEST_MOVES[event.kind]) status = REQUEST_MOVES[event.kind];
  }
  // Nothing logged before the end: the record is the answer only if nothing changed since.
  if (status === null && !list.some((event) => event.at >= state.to && event.kind !== 'request.seen')) status = request.status;
  const lastReply = request.lastReplyAt && request.lastReplyAt < state.to ? (request.lastReply ?? null) : null;
  return { open: existed(request, state.to) && status === 'waiting-on-master', status, lastReply };
}

const APPROVAL_STEPS = {
  'approval.opened': () => ({ open: true, status: 'pending' }),
  'approval.decided': (payload) => ({ open: false, status: payload.action === 'reject' ? 'rejected' : 'approved', prior: { open: true, status: 'pending' } }),
  'approval.stale-closed': () => ({ open: false, status: 'stale-closed', prior: { open: true, status: 'pending' } }),
};
const SUGGESTION_DECISIONS = { accept: 'accepted', 'accept-edited': 'edited', dismiss: 'dismissed' };
const SUGGESTION_STEPS = {
  // A dismissed suggestion the owner takes back is opened again.
  'suggestion.opened': (payload) => ({ open: true, status: 'open', prior: payload.reopened ? { open: false, status: 'dismissed' } : undefined }),
  'suggestion.decided': (payload) => ({ open: false, status: SUGGESTION_DECISIONS[payload.action] ?? 'decided', prior: { open: true, status: 'open' } }),
};
// A draft is open while it waits on a decision or a rewrite; approved, sent and dropped are closed.
const DRAFT_DECISIONS = {
  approve: () => ({ open: false, status: 'approved', prior: { open: true, status: 'pending' } }),
  drop: () => ({ open: false, status: 'dropped', prior: { open: true, status: 'pending' } }),
  withdraw: () => ({ open: false, status: 'dropped', prior: { open: true, status: 'pending' } }),
  rewrite: () => ({ open: true, status: 'rewrite-requested', prior: { open: true, status: 'pending' } }),
  reopen: (payload) => ({ open: true, status: 'pending', prior: { open: false, status: payload.previousStatus ?? 'closed' } }),
};
const DRAFT_STEPS = {
  'draft.opened': (payload) => ({ open: true, status: 'pending', prior: payload.revision ? { open: true, status: 'rewrite-requested' } : undefined }),
  'draft.decided': (payload) => DRAFT_DECISIONS[payload.action]?.(payload) ?? null,
  'draft.stale-closed': () => ({ open: false, status: 'dropped', prior: { open: true, status: 'pending' } }),
  'draft.sent': () => ({ open: false, status: 'sent', prior: { open: false, status: 'approved' } }),
  'draft.send-failed': () => ({ open: false, status: 'send-failed', prior: { open: false, status: 'approved' } }),
};

export const approvalAt = (state, approval) =>
  phaseAt(state, 'approval', approval, stepper(APPROVAL_STEPS), { open: approval.status === 'pending', openStatus: 'pending', decidedAt: approval.decidedAt });
export const suggestionAt = (state, suggestion) =>
  phaseAt(state, 'suggestion', suggestion, stepper(SUGGESTION_STEPS), { open: suggestion.status === 'open', openStatus: 'open', decidedAt: suggestion.decidedAt });
export const draftAt = (state, draft) =>
  phaseAt(state, 'draft', draft, stepper(DRAFT_STEPS), {
    open: draft.status === 'pending' || draft.status === 'rewrite-requested',
    openStatus: 'pending',
    decidedAt: draft.decidedAt ?? draft.sentAt,
  });

// The last logged value of a field before the end; if nothing was logged
// before it, the record's value when the first later change left that field
// alone, or the record's value when nothing changed later; else null.
const valueAt = (list, to, field, read, current) => {
  const before = list.filter((event) => event.at < to && read(event) != null).at(-1);
  if (before) return read(before);
  const later = list.find((event) => event.at >= to);
  if (!later) return current;
  return later.payload?.changed?.includes(field) ? null : (read(later) ?? null);
};

/**
 * A record's title at the end: the title after the last event before it;
 * failing that, the title the first later event kept (null if that event
 * renamed it); with nothing logged, the record's.
 */
export function titleAt(state, kind, record) {
  const list = eventsFor(state, kind, record.id);
  const before = list.filter((event) => event.at < state.to && event.label).at(-1);
  if (before) return before.label;
  const later = list.find((event) => event.at >= state.to);
  if (!later) return record.title ?? null;
  return later.payload?.changed?.includes('title') ? null : (later.label ?? record.title ?? null);
}

/** A milestone's status at the end, or null when the log can't tell. */
export function milestoneAt(state, milestone) {
  const list = eventsFor(state, 'milestone', milestone.id).filter((event) => event.kind === 'milestone.updated');
  return valueAt(list, state.to, 'status', (event) => event.payload?.status ?? null, milestone.status);
}

/**
 * A work item at the end: its stage (null when unknown), and its blockers,
 * PR and facts, which the log doesn't keep: known only when they haven't
 * changed since.
 */
export function workItemAt(state, item) {
  const list = eventsFor(state, 'work-item', item.id).filter((event) => event.kind === 'work-item.updated');
  const changedLater = (field) => list.some((event) => event.at >= state.to && event.payload?.changed?.includes(field));
  return {
    stage: valueAt(list, state.to, 'stage', (event) => event.payload?.stage ?? null, item.stage),
    blockedBy: changedLater('blockedBy') ? null : (item.blockedBy ?? []),
    prKnown: !changedLater('pullRequest'),
    factsKnown: !changedLater('facts'),
  };
}

// Titles and questions keep their shape: banned words become "...", nothing is dropped.
const label = (text, banned, max) => {
  const out = redact(String(text ?? ''), banned).replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max).trimEnd()}...` : out;
};

const prRef = (item) => {
  const pr = item.pullRequest;
  if (!pr?.repository || !pr.number) return null;
  return `${String(pr.repository).replace(/^[^/]+\//, '')}#${pr.number}`;
};

const blockerLabels = (config, blockedBy) =>
  (blockedBy ?? []).map((block) => scrub(expand(block.label ?? block.id ?? '', config.aliases), config.banned, 160)).filter(Boolean);

// Renamed after the end with no earlier title logged: say so rather than show the later title.
const workItemTitle = (config, state, item) => {
  const title = titleAt(state, 'work-item', item);
  return title === null ? 'A work item renamed after this window' : label(expand(title, config.aliases), config.banned, 200);
};

/** Work items that changed in the window, with the stage moves they made in it and where they stood at the end. */
function workItems(state, { config, from, to }) {
  const out = [];
  for (const item of state.byKind.get('work-item')) {
    if (!existed(item, to)) continue;
    const list = eventsFor(state, 'work-item', item.id);
    const moves = [];
    for (const event of list) {
      if (!within(event.at, from, to)) continue;
      if (event.kind === 'work-item.created') moves.push({ at: event.at, stage: 'created' });
      else if (event.payload?.changed?.includes('stage') && event.payload.stage) moves.push({ at: event.at, stage: event.payload.stage });
    }
    const active = list.some((event) => within(event.at, from, to)) || within(item.createdAt, from, to) || (!list.length && within(item.updatedAt, from, to));
    if (!active) continue;
    const at = workItemAt(state, item);
    out.push({
      id: item.id,
      title: workItemTitle(config, state, item),
      stage: at.stage ?? 'unknown',
      pr: at.prKnown ? prRef(item) : null,
      blockedBy: blockerLabels(config, at.blockedBy),
      readback: at.factsKnown ? scrub(expand(item.facts?.deployedReadback ?? '', config.aliases), config.banned, 200) || null : null,
      exercised: at.factsKnown ? scrub(expand(item.facts?.exercised ?? '', config.aliases), config.banned, 200) || null : null,
      createdAt: item.createdAt,
      updatedAt: list.filter((event) => event.at < to).at(-1)?.at ?? item.createdAt,
      moves,
    });
  }
  return out.sort((a, b) => (a.updatedAt ?? '').localeCompare(b.updatedAt ?? ''));
}

/** Every work item blocked and not done at the end, whether or not it moved in the window. */
function blocked(state, { config, to }) {
  const out = [];
  for (const item of state.byKind.get('work-item')) {
    if (!existed(item, to)) continue;
    const at = workItemAt(state, item);
    if (at.stage === 'done' || !at.blockedBy?.length) continue;
    const since = eventsFor(state, 'work-item', item.id).filter((event) => event.at < to && event.payload?.changed?.includes('blockedBy')).at(-1)?.at;
    out.push({ id: item.id, title: workItemTitle(config, state, item), stage: at.stage ?? 'unknown', blockedBy: blockerLabels(config, at.blockedBy), since: since ?? item.createdAt });
  }
  return out;
}

/** Asks opened or closed in the window, or open at its end. */
function asks(state, { config, from, to }) {
  return state.byKind
    .get('ask')
    .map((ask) => ({ ask, at: askAt(state, ask) }))
    .filter(({ ask, at }) => at.open || within(ask.createdAt, from, to) || within(at.closedAt, from, to))
    .map(({ ask, at }) => ({
      ref: `ask:${ask.id}`,
      question: label(expand(ask.question, config.aliases), config.banned, 300),
      status: at.status,
      openAtEnd: at.open,
      answer: at.answer ? scrub(expand(at.answer, config.aliases), config.banned, 300) || null : null,
      openedAt: ask.createdAt,
      answeredAt: at.closedAt,
    }));
}

/** Owner requests: his own words, and where each one stood at the end. */
function requests(state, { config, from, to }) {
  return state.byKind
    .get('owner-request')
    .filter((request) => existed(request, to))
    .map((request) => ({ request, at: requestAt(state, request) }))
    .filter(({ request, at }) => at.open || within(request.createdAt, from, to) || eventsFor(state, 'owner-request', request.id).some((event) => within(event.at, from, to)))
    .map(({ request, at }) => ({
      ref: `request:${request.id}`,
      title: String(request.title ?? '').slice(0, 300),
      status: at.status ?? 'unknown',
      openedAt: request.createdAt,
      lastReply: at.lastReply ? scrub(expand(at.lastReply, config.aliases), config.banned, 300) || null : null,
    }));
}

function approvals(state, { config, from, to }) {
  let approved = 0;
  let rejected = 0;
  const pending = [];
  for (const approval of state.byKind.get('approval')) {
    const at = approvalAt(state, approval);
    if (at.open) pending.push({ ref: `approval:${approval.id}`, title: label(expand(approval.title, config.aliases), config.banned, 200), openedAt: approval.createdAt });
    else if (within(at.closedAt, from, to)) {
      if (at.status === 'approved') approved += 1;
      else if (at.status === 'rejected') rejected += 1;
    }
  }
  return { decided: approved + rejected, approved, rejected, pending };
}

/** Outward drafts: what happened to them in the window, and which waited at its end. */
function drafts(state, { from, to }) {
  const out = { opened: 0, sent: 0, approved: 0, dropped: 0, pending: [] };
  for (const draft of state.byKind.get('draft')) {
    if (!existed(draft, to)) continue;
    if (within(draft.createdAt, from, to)) out.opened += 1;
    for (const event of eventsFor(state, 'draft', draft.id)) {
      if (!within(event.at, from, to)) continue;
      const action = event.kind === 'draft.decided' ? event.payload?.action : null;
      if (event.kind === 'draft.sent') out.sent += 1;
      else if (action === 'approve') out.approved += 1;
      else if (action === 'drop' || action === 'withdraw' || event.kind === 'draft.stale-closed') out.dropped += 1;
    }
    if (draftAt(state, draft).open) {
      out.pending.push({ ref: `draft:${draft.id}`, audience: draft.audience ?? null, target: draft.target?.label ?? null, openedAt: draft.createdAt });
    }
  }
  return out;
}

function milestones(state, { config, to }) {
  return state.byKind
    .get('milestone')
    .filter((milestone) => existed(milestone, to))
    .map((milestone) => {
      const list = eventsFor(state, 'milestone', milestone.id);
      const noteKnown = !list.some((event) => event.at >= to && event.payload?.changed?.includes('statusNote'));
      const title = titleAt(state, 'milestone', milestone);
      return {
        ref: `milestone:${milestone.id}`,
        title: title === null ? 'A milestone renamed after this window' : label(expand(title, config.aliases), config.banned, 200),
        status: milestoneAt(state, milestone) ?? 'unknown',
        note: noteKnown ? scrub(expand(milestone.statusNote ?? '', config.aliases), config.banned, 400) || null : null,
        updatedAt: list.filter((event) => event.at < to).at(-1)?.at ?? milestone.createdAt,
      };
    });
}

/** Suggestions only the owner can accept, open at the end. */
function suggestions(state, { config }) {
  return state.byKind
    .get('suggestion')
    .filter((suggestion) => suggestion.acceptor === 'owner' && suggestionAt(state, suggestion).open)
    .map((suggestion) => ({ ref: `suggestion:${suggestion.id}`, title: label(expand(suggestion.title, config.aliases), config.banned, 200), openedAt: suggestion.createdAt }));
}

/**
 * Lane messages of the configured kinds, newest last, scrubbed of internal
 * names and cut to the configured total size (oldest dropped first).
 */
function messages(db, { config, from, to }) {
  const { kinds, maxChars } = config.messages;
  if (!kinds.length) return { kept: [], dropped: 0 };
  const rows = db
    .prepare(
      `select kind, created_at, message_json from ardud_mission_router_messages
        where mission_id = ? and created_at >= ? and created_at < ? and kind in (${kinds.map(() => '?').join(',')})
        order by seq`,
    )
    .all(config.id, from, to, ...kinds);
  const all = rows
    .map((row) => {
      const message = JSON.parse(row.message_json);
      return { at: row.created_at, kind: row.kind, text: scrub(expand(message.summary ?? '', config.aliases), config.banned, 400) };
    })
    .filter((message) => message.text);
  const kept = [];
  let size = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    size += all[i].text.length + 30;
    if (size > maxChars) break;
    kept.unshift(all[i]);
  }
  return { kept, dropped: all.length - kept.length };
}

function usage(db, { config, from, to }) {
  const row = db
    .prepare(
      `select count(*) batches, coalesce(sum(input_tokens), 0) input, coalesce(sum(output_tokens), 0) output
         from ardud_mission_scribe_batch where mission_id = ? and created_at >= ? and created_at < ?`,
    )
    .get(config.id, from, to);
  return { batches: Number(row.batches), inputTokens: Number(row.input), outputTokens: Number(row.output) };
}

/** Everything the mission's records say about [from, to), as of `to`. */
export function missionFacts(db, { config, from, to }) {
  const state = loadState(db, config.id, to);
  const args = { config, from, to };
  return {
    workItems: workItems(state, args),
    blocked: blocked(state, args),
    asks: asks(state, args),
    requests: requests(state, args),
    approvals: approvals(state, args),
    drafts: drafts(state, args),
    milestones: milestones(state, args),
    suggestions: suggestions(state, args),
    messages: messages(db, args),
    usage: usage(db, args),
  };
}

/** Things waiting at the end of the window, as report open items {ref, label, since}. */
export function openItems(facts) {
  const out = [];
  for (const ask of facts.asks) if (ask.openAtEnd) out.push({ ref: ask.ref, label: ask.question, since: ask.openedAt });
  for (const request of facts.requests) if (request.status === 'waiting-on-master') out.push({ ref: request.ref, label: request.title, since: request.openedAt });
  for (const approval of facts.approvals.pending) out.push({ ref: approval.ref, label: approval.title, since: approval.openedAt });
  for (const suggestion of facts.suggestions) out.push({ ref: suggestion.ref, label: suggestion.title, since: suggestion.openedAt });
  for (const item of facts.blocked) out.push({ ref: `work-item:${item.id}`, label: `${item.title} (blocked: ${item.blockedBy.join('; ')})`.slice(0, 300), since: item.since });
  for (const milestone of facts.milestones) if (milestone.status === 'at-risk') out.push({ ref: milestone.ref, label: milestone.title, since: milestone.updatedAt });
  return out.map((item) => ({ ...item, since: item.since ?? new Date(0).toISOString() }));
}

/**
 * The report this one follows: the newest current saved report of `kind`
 * that ended before `to` (at or before it unless `strict`). Current means
 * what the report store shows: the latest revision for its end, and for a
 * daily, not overlapped by a daily saved later (same rule, same tie-break).
 */
export function previousReport(db, { missionId, kind, to, strict = false }) {
  const columns = new Set(db.prepare('pragma table_info(ardud_mission_scribe_report)').all().map((column) => column.name));
  const revised = columns.has('revision');
  const row = db
    .prepare(
      `select r.covers_from, r.covers_to, r.open_json, r.text${columns.has('facts_json') ? ', r.facts_json' : ''}
         from ardud_mission_scribe_report r
        where r.mission_id = ? and r.kind = ? and r.covers_to ${strict ? '<' : '<='} ?
          and not exists (
            select 1 from ardud_mission_scribe_report n
             where n.mission_id = r.mission_id and n.kind = r.kind and n.report_id <> r.report_id
               and (${revised ? '(n.covers_to = r.covers_to and n.revision > r.revision) or ' : ''}
                    (r.kind = 'daily' and n.covers_from < r.covers_to and n.covers_to > r.covers_from
                     and (n.created_at > r.created_at or (n.created_at = r.created_at and n.rowid > r.rowid)))))
        order by r.covers_to desc, r.created_at desc
        limit 1`,
    )
    .get(missionId, kind, to);
  if (!row) return null;
  return {
    coversFrom: row.covers_from,
    coversTo: row.covers_to,
    text: row.text,
    open: safeJson(row.open_json, []),
    facts: row.facts_json ? safeJson(row.facts_json, null) : null,
  };
}

const REF_KINDS = { ask: 'ask', request: 'owner-request', approval: 'approval', suggestion: 'suggestion', 'work-item': 'work-item', milestone: 'milestone' };

/** Open-item ref prefixes the writer tracks (server-built reports also carry note: items). */
export const TRACKED_REFS = Object.keys(REF_KINDS);

// How an open item stood at the end: how it ended, or null while still open (or unknown).
function outcomeAt(state, ref) {
  const at = String(ref).indexOf(':');
  const kind = REF_KINDS[String(ref).slice(0, at)];
  const record = state.records.get(`${kind}:${String(ref).slice(at + 1)}`);
  if (!record) return 'Gone from the records.';
  switch (kind) {
    case 'ask': {
      const ask = askAt(state, record);
      if (ask.open) return null;
      if (ask.status === 'answered') return ask.answer ? `Answered: ${String(ask.answer).slice(0, 200)}` : 'Answered.';
      return `Dropped (${ask.status}).`;
    }
    case 'owner-request': {
      const request = requestAt(state, record);
      if (request.status === null || request.open) return null;
      return request.status === 'settled' ? 'Settled.' : 'Answered.';
    }
    case 'approval': {
      const approval = approvalAt(state, record);
      if (approval.open) return null;
      if (approval.status === 'approved') return 'Approved.';
      if (approval.status === 'rejected') return 'Rejected.';
      return `Closed (${approval.status}).`;
    }
    case 'suggestion': {
      const suggestion = suggestionAt(state, record);
      if (suggestion.open) return null;
      return suggestion.status === 'edited' ? 'Accepted with edits.' : `${suggestion.status[0].toUpperCase()}${suggestion.status.slice(1)}.`;
    }
    case 'work-item': {
      const item = workItemAt(state, record);
      if (item.stage === 'done') return 'Done.';
      if (item.blockedBy === null || item.blockedBy.length) return null;
      return item.stage ? `Unblocked, now at ${item.stage}.` : 'Unblocked.';
    }
    case 'milestone': {
      const status = milestoneAt(state, record);
      return status === null || status === 'at-risk' ? null : `Now ${status}.`;
    }
    default:
      return null;
  }
}

const LONG_OPEN_MS = 12 * 3_600_000;

/**
 * What became of the items the previous report left open, as of `to`: the
 * ones that changed (with how), and a count of the rest. Items of kinds the
 * writer doesn't track (server-built reports also list notes) are ignored.
 */
export function hanging(db, { config, previousOpen, to }) {
  const state = loadState(db, config.id, to);
  const changed = [];
  let unchanged = 0;
  let longOpen = 0;
  for (const item of previousOpen ?? []) {
    if (!TRACKED_REFS.includes(String(item.ref).split(':')[0])) continue;
    const outcome = outcomeAt(state, item.ref);
    if (outcome) {
      changed.push({ ref: item.ref, label: redact(item.label, config.banned), outcome: redact(expand(outcome, config.aliases), config.banned) });
    } else {
      unchanged += 1;
      if (Date.parse(to) - Date.parse(item.since) > LONG_OPEN_MS) longOpen += 1;
    }
  }
  return { changed, unchanged, longOpen };
}

const safeJson = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

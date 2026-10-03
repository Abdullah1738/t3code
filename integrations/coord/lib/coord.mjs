import { createHash } from 'node:crypto';
import { tx, get, all, run, CoordError } from './db.mjs';
import * as evidence from './evidence.mjs';

export { evidence, CoordError };

export { open, close } from './db.mjs';

export const clock = { now: () => Math.floor(Date.now() / 1000) };
const now = () => clock.now();

const refuse = (code, message, extra) => new CoordError(code, message, extra);

const EVENT_KINDS = ['request', 'decision', 'status', 'evidence', 'blocker', 'control'];
const RELEASE_KINDS = ['service_release', 'frontend_release', 'redispatch', 'tf_apply', 'ddl', 'migration', 'qa_window'];
const MANUAL_KINDS = ['tf_apply', 'ddl', 'migration'];
const DEPLOY_KINDS = ['service_release', 'frontend_release', 'redispatch'];
const ARCH_KINDS = ['drift_audit', 'contract_change', 'doc_fix', 'suspected_bug'];
const DEP_NEEDS = ['pr_merged', 'pr_deployed', 'ticket_done', 'release_done', 'event_acked', 'claim_free', 'manual'];
const list = (v, dflt) => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : dflt);
export const DEFAULTS = {
  ttl: 1800,
  reconcilers: list(process.env.COORD_RECONCILERS, ['master', 'release']),
  admitters: list(process.env.COORD_ADMITTERS, ['master', 'release']),
  approvalSources: list(process.env.COORD_APPROVAL_SOURCES, ['web', 'mobile']),
  unackedAfter: 1800,
};

const canon = v => Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canon(v[k])])) : v;
export const hash = v => createHash('sha256').update(JSON.stringify(canon(v))).digest('hex');
const json = v => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = s => { try { return s == null ? null : JSON.parse(s); } catch { return s; } };

export function parseTtl(v, dflt = DEFAULTS.ttl) {
  if (v === undefined || v === null || v === '') return dflt;
  const m = /^(\d+)\s*([smhd]?)$/.exec(String(v));
  if (!m) throw refuse('invalid', `bad ttl ${v}`);
  return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}
const need = (v, name) => { if (v === undefined || v === null || v === '') throw refuse('invalid', `${name} is required`); return v; };

// ---------- control: pause / drain / flags ----------

const RANK = { run: 0, drain: 1, pause: 2 };

export function setMode(mode, { scope, as, reason } = {}) {
  if (!(mode in RANK)) throw refuse('invalid', `mode must be run|drain|pause`);
  need(as, 'as');
  const k = scope ? `mode:${scope}` : 'mode';
  run('INSERT INTO control (k,v,set_by,set_at,reason) VALUES (?,?,?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, set_by=excluded.set_by, set_at=excluded.set_at, reason=excluded.reason',
    k, mode, as, now(), reason ?? null);
  return { key: k, mode };
}

export const FLAG_DEFAULTS = { tf_full_root_blocked: true };
export const FLAG_CLEARERS = { tf_full_root_blocked: ['master'] };

export function setFlag(k, on, { as, reason } = {}) {
  need(as, 'as');
  if (!on && FLAG_CLEARERS[k] && !FLAG_CLEARERS[k].includes(as)) throw refuse('forbidden', `only ${FLAG_CLEARERS[k].join('|')} may clear ${k}`);
  run('INSERT INTO control (k,v,set_by,set_at,reason) VALUES (?,?,?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, set_by=excluded.set_by, set_at=excluded.set_at, reason=excluded.reason',
    k, on ? '1' : '0', as, now(), reason ?? null);
  return { key: k, on: !!on };
}
export function flag(k) {
  const v = get('SELECT v FROM control WHERE k=?', k)?.v;
  return v === undefined ? !!FLAG_DEFAULTS[k] : v === '1';
}

// Effective mode of a scope: the strictest of the global mode and the scope's own mode.
export function gate(scope) {
  let best = { mode: 'run', key: 'mode' };
  for (const k of scope ? ['mode', `mode:${scope}`] : ['mode']) {
    const r = get('SELECT * FROM control WHERE k=?', k);
    if (r && RANK[r.v] > RANK[best.mode]) best = { mode: r.v, key: k, set_by: r.set_by, reason: r.reason, set_at: r.set_at };
  }
  return { ok: best.mode === 'run', scope: scope ?? null, ...best };
}

function requireMode(scope, allowDrain) {
  const g = gate(scope);
  if (g.mode === 'pause' || (g.mode === 'drain' && !allowDrain))
    throw refuse(g.mode === 'pause' ? 'paused' : 'draining', `${g.key} is ${g.mode}${g.reason ? `: ${g.reason}` : ''}`, { gate: g });
}
const resourceScope = r => (/^env:/.test(r) ? r : undefined);

// ---------- actors, channels, members ----------

export function actorSet(id, { thread, kind } = {}) {
  need(id, 'actor id');
  const k = kind ?? (thread ? 'thread' : 'process');
  if (!['thread', 'process'].includes(k)) throw refuse('invalid', 'kind must be thread|process');
  if (k === 'thread' && !thread) throw refuse('invalid', 'thread actors need --thread');
  return tx(() => {
    run('INSERT INTO actors (id,kind,thread_id,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, thread_id=excluded.thread_id, updated_at=excluded.updated_at',
      id, k, k === 'thread' ? thread : null, now());
    // Pending and failed deliveries follow the actor to its new thread.
    const r = k === 'thread'
      ? run("UPDATE deliveries SET thread_id=?, status='pending', next_attempt_at=NULL, attempts=0, last_error=NULL, gen=gen+1 WHERE recipient=? AND status IN ('pending','failed')", thread, id)
      : run("UPDATE deliveries SET thread_id=NULL, status='skipped', gen=gen+1 WHERE recipient=? AND status IN ('pending','failed')", id);
    return { actor: get('SELECT * FROM actors WHERE id=?', id), retargeted: Number(r.changes) };
  });
}
const actor = id => get('SELECT * FROM actors WHERE id=?', id);

// Creates the actor if missing; an existing actor (and its thread binding) is left alone.
export function ensureActor(id, { thread, kind } = {}) {
  const a = actor(need(id, 'actor id'));
  return a ? { actor: a, existing: true } : actorSet(id, { thread, kind });
}

// Idempotent first-run seed: the pull-only crw process actor.
export function init() {
  return { actors: [ensureActor('crw', { kind: 'process' })] };
}

export function channelCreate(id, { owner, purpose } = {}) {
  need(id, 'channel id'); need(owner, 'owner');
  const r = get('SELECT * FROM channels WHERE id=?', id);
  if (r) return { channel: r, existing: true };
  run('INSERT INTO channels (id,purpose,owner,created_at) VALUES (?,?,?,?)', id, purpose ?? null, owner, now());
  return { channel: get('SELECT * FROM channels WHERE id=?', id) };
}

export function channelArchive(id, { note } = {}) {
  need(note, 'note');
  return tx(() => {
    const c = get('SELECT * FROM channels WHERE id=?', id);
    if (!c) throw refuse('not_found', `no channel ${id}`);
    const open = get("SELECT COUNT(*) n FROM deliveries d JOIN events e ON e.seq=d.event_seq WHERE e.channel_id=? AND d.status!='acked'", id).n;
    if (open) throw refuse('unacked', `${open} deliveries in ${id} are not acked`);
    const held = all("SELECT resource FROM claims WHERE state IN ('active','reconcile_required') AND (resource=? OR resource LIKE ?)", `channel:${id}`, `channel:${id}:%`);
    if (held.length) throw refuse('claimed', `active claims reference ${id}`, { claims: held.map(c => c.resource) });
    run("UPDATE channels SET status='archived', archived_at=?, archive_note=? WHERE id=?", now(), note, id);
    return { channel: get('SELECT * FROM channels WHERE id=?', id) };
  });
}

export function memberAdd(channel, actorId, { wake = false } = {}) {
  if (!get('SELECT 1 FROM channels WHERE id=?', channel)) throw refuse('not_found', `no channel ${channel}`);
  if (!actor(actorId)) throw refuse('unknown_actor', `no actor ${actorId}`);
  run('INSERT INTO members (channel_id,actor_id,wake) VALUES (?,?,?) ON CONFLICT DO UPDATE SET wake=excluded.wake', channel, actorId, wake ? 1 : 0);
  return { channel, actor: actorId, wake: !!wake };
}
export function memberRm(channel, actorId) {
  return { removed: Number(run('DELETE FROM members WHERE channel_id=? AND actor_id=?', channel, actorId).changes) };
}

// ---------- events, deliveries, ack ----------

// Unambiguous per (event, recipient): colons in either part cannot collide.
export const deliveryId = (eventKey, recipient) => `coord:${createHash('sha256').update(JSON.stringify([eventKey, recipient])).digest('hex')}`;

export function post(channel, o = {}) {
  const { as, kind, key, summary } = o;
  need(as, 'as'); need(key, 'key'); need(summary, 'summary');
  if (!EVENT_KINDS.includes(kind)) throw refuse('invalid', `kind must be one of ${EVENT_KINDS.join('|')}`);
  const to = Array.isArray(o.to) ? o.to : list(o.to, null);
  const fields = { channel, kind, sender: as, work: o.work, env: o.env, rev: o.rev, authority: o.authority, summary, body: o.body, reply_to: o.replyTo, to };
  const h = hash(fields);
  return tx(() => {
    const prev = get('SELECT seq, body_hash FROM events WHERE event_key=?', key);
    if (prev) {
      if (prev.body_hash !== h) throw refuse('conflict', `event ${key} exists with a different body`, { status: 409, seq: prev.seq });
      return { seq: prev.seq, duplicate: true };
    }
    const c = get('SELECT * FROM channels WHERE id=?', channel);
    if (!c) throw refuse('not_found', `no channel ${channel}`);
    if (c.status !== 'open') throw refuse('channel_archived', `channel ${channel} is archived`);
    const members = all('SELECT * FROM members WHERE channel_id=?', channel);
    const recips = (to ?? members.map(m => m.actor_id)).filter(r => r !== as);
    for (const r of recips) if (!actor(r)) throw refuse('unknown_actor', `no actor ${r}`);
    const t = now();
    const seq = Number(run(`INSERT INTO events (event_key,body_hash,channel_id,kind,sender,work_id,environment,expected_revision,authority_ref,summary,body_json,reply_to,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, key, h, channel, kind, as, o.work ?? null, o.env ?? null, o.rev ?? null, o.authority ?? null, summary,
      json(o.body), o.replyTo ?? null, t).lastInsertRowid);
    for (const r of [...new Set(recips)]) {
      const a = actor(r);
      const push = a.kind === 'thread' && a.thread_id && (to || members.find(m => m.actor_id === r)?.wake);
      run('INSERT INTO deliveries (event_seq,recipient,status,client_request_id,thread_id) VALUES (?,?,?,?,?)',
        seq, r, push ? 'pending' : 'skipped', deliveryId(key, r), push ? a.thread_id : null);
    }
    return { seq, recipients: recips };
  });
}

export function inbox({ as, unacked = false, after = 0, limit = 100 } = {}) {
  need(as, 'as');
  return {
    events: all(`SELECT e.*, d.status delivery, d.acked_at FROM deliveries d JOIN events e ON e.seq=d.event_seq
      WHERE d.recipient=? AND e.seq>? ${unacked ? "AND d.status!='acked'" : ''} ORDER BY e.seq LIMIT ?`, as, Number(after) || 0, Number(limit))
      .map(e => ({ ...e, body_json: parse(e.body_json) })),
  };
}

export function ack(as, refs = []) {
  need(as, 'as');
  return tx(() => ({
    acked: refs.map(ref => {
      const e = /^\d+$/.test(String(ref)) ? get('SELECT seq FROM events WHERE seq=?', Number(ref)) : get('SELECT seq FROM events WHERE event_key=?', ref);
      if (!e) throw refuse('not_found', `no event ${ref}`);
      const d = get('SELECT * FROM deliveries WHERE event_seq=? AND recipient=?', e.seq, as);
      if (!d) throw refuse('not_addressed', `event ${ref} was not addressed to ${as}`);
      if (d.status === 'acked') return { seq: e.seq, already: true };
      run("UPDATE deliveries SET status='acked', acked_at=?, gen=gen+1 WHERE event_seq=? AND recipient=?", now(), e.seq, as);
      return { seq: e.seq };
    }),
  }));
}

// ---------- claims ----------

function expire(c) {
  if (c?.state === 'active' && c.lease_until <= now()) {
    run("UPDATE claims SET state='reconcile_required' WHERE resource=?", c.resource);
    return { ...c, state: 'reconcile_required' };
  }
  return c;
}
const reconcileErr = c => refuse('reconcile_required', `${c.resource} lease of ${c.owner} expired; reconcile before reuse`,
  { owner: c.owner, fence: c.fence, op_ref: c.op_ref, reconcile_outcome: c.reconcile_outcome });

export function claim(resource, { as, ttl, purpose, op } = {}) {
  need(resource, 'resource'); need(as, 'as');
  const secs = parseTtl(ttl);
  return tx(() => {
    requireMode(resourceScope(resource));
    const c = expire(get('SELECT * FROM claims WHERE resource=?', resource));
    if (c?.state === 'reconcile_required') return reconcileErr(c);
    if (c?.state === 'active') throw refuse('held', `${resource} is held by ${c.owner}`, { owner: c.owner, fence: c.fence, lease_until: c.lease_until });
    if (c) run(`INSERT OR IGNORE INTO claim_history (resource,fence,owner,state,op_ref,reconcile_by,reconcile_outcome,reconcile_evidence,ended_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, c.resource, c.fence, c.owner, c.state, c.op_ref, c.reconcile_by, c.reconcile_outcome, c.reconcile_evidence, c.released_at ?? now());
    run('INSERT INTO fences (resource,fence) VALUES (?,1) ON CONFLICT(resource) DO UPDATE SET fence=fence+1', resource);
    const fence = get('SELECT fence FROM fences WHERE resource=?', resource).fence;
    const t = now();
    run(`INSERT OR REPLACE INTO claims (resource,owner,fence,state,lease_until,purpose,op_ref,claimed_at,renewed_at)
      VALUES (?,?,?,'active',?,?,?,?,?)`, resource, as, fence, t + secs, purpose ?? null, op ?? null, t, t);
    return { resource, fence, lease_until: t + secs };
  });
}

function holder(resource, as, fence) {
  const c = expire(get('SELECT * FROM claims WHERE resource=?', resource));
  if (!c) return refuse('not_held', `${resource} is not claimed`);
  if (c.state === 'reconcile_required') return reconcileErr(c);
  if (c.state !== 'active' || c.owner !== as || c.fence !== Number(fence))
    return refuse('stale_fence', `${as} fence ${fence} does not hold ${resource}`, { owner: c.owner, fence: c.fence, state: c.state });
  return c;
}

export function check(resource, { as, fence } = {}) {
  return tx(() => {
    const c = holder(resource, as, fence);
    return c instanceof Error ? c : { resource, owner: c.owner, fence: c.fence, lease_until: c.lease_until };
  });
}

export function renew(resource, { as, fence, ttl, op } = {}) {
  const secs = parseTtl(ttl);
  return tx(() => {
    const c = holder(resource, as, fence);
    if (c instanceof Error) return c;
    const t = now();
    run('UPDATE claims SET lease_until=?, renewed_at=?, op_ref=COALESCE(?,op_ref) WHERE resource=?', t + secs, t, op ?? null, resource);
    return { resource, fence: c.fence, lease_until: t + secs };
  });
}

// An expired lease cannot be released: its operation may still be running, so it needs reconcile.
export function release(resource, { as, fence, note } = {}) {
  return tx(() => {
    const c = holder(resource, as, fence);
    if (c instanceof Error) return c;
    run("UPDATE claims SET state='released', released_at=?, note=? WHERE resource=?", now(), note ?? null, resource);
    return { resource, fence: c.fence, state: 'released' };
  });
}

export function reconcile(resource, { as, outcome, evidence } = {}) {
  need(as, 'as'); need(evidence, 'evidence');
  if (!['done', 'not_started', 'rolled_back', 'still_running'].includes(outcome))
    throw refuse('invalid', 'outcome must be done|not_started|rolled_back|still_running');
  if (!DEFAULTS.reconcilers.includes(as)) throw refuse('forbidden', `${as} may not reconcile (allowed: ${DEFAULTS.reconcilers.join(',')})`);
  return tx(() => {
    const c = expire(get('SELECT * FROM claims WHERE resource=?', resource));
    if (c?.state !== 'reconcile_required') throw refuse('not_reconcilable', `${resource} is ${c?.state ?? 'unclaimed'}`);
    const state = outcome === 'still_running' ? 'reconcile_required' : 'reconciled';
    run('UPDATE claims SET state=?, reconcile_by=?, reconcile_outcome=?, reconcile_evidence=?, released_at=? WHERE resource=?', state, as, outcome, evidence, now(), resource);
    return { resource, state, outcome };
  });
}

export function claims({ owner, state } = {}) {
  return { claims: all('SELECT * FROM claims WHERE (? IS NULL OR owner=?) AND (? IS NULL OR state=?) ORDER BY resource', owner ?? null, owner ?? null, state ?? null, state ?? null) };
}

// ---------- dependency readiness ----------

export function depAdd(work, needKind, ref) {
  if (!DEP_NEEDS.includes(needKind)) throw refuse('invalid', `need must be one of ${DEP_NEEDS.join('|')}`);
  need(work, 'work'); need(ref, 'ref');
  run('INSERT INTO deps (work_id,need,ref) VALUES (?,?,?) ON CONFLICT DO NOTHING', work, needKind, ref);
  return { dep: get('SELECT * FROM deps WHERE work_id=? AND need=? AND ref=?', work, needKind, ref) };
}

export function depSet(id, { state, evidence } = {}) {
  if (!['waiting', 'ready', 'dead'].includes(state)) throw refuse('invalid', 'state must be waiting|ready|dead');
  const d = get('SELECT * FROM deps WHERE id=?', Number(id));
  if (!d) throw refuse('not_found', `no dep ${id}`);
  if (state === 'ready' && !evidence) throw refuse('invalid', 'evidence is required');
  run('UPDATE deps SET state=?, evidence=?, why=?, checked_at=?, version=version+1 WHERE id=?', state, evidence ?? null, 'set by hand', now(), d.id);
  return { dep: get('SELECT * FROM deps WHERE id=?', d.id) };
}

// External needs (pr_merged, pr_deployed) are evaluated by `external(dep)` when supplied (see evidence.mjs).
export async function ready(work, { external = evidence.external } = {}) {
  const out = [];
  for (const d of all('SELECT * FROM deps WHERE work_id=? ORDER BY id', work)) {
    let r = { state: d.state, why: d.why, evidence: d.evidence };
    if (d.state !== 'dead' && !(d.state === 'ready' && ['manual', 'ticket_done'].includes(d.need))) {
      if (d.need === 'event_acked') {
        const e = get('SELECT seq FROM events WHERE event_key=?', d.ref);
        const open = e && get("SELECT COUNT(*) n FROM deliveries WHERE event_seq=? AND status!='acked'", e.seq).n;
        r = !e ? { state: 'waiting', why: 'event not posted' } : open ? { state: 'waiting', why: `${open} recipients unacked` } : { state: 'ready', why: 'all acked', evidence: `seq ${e.seq}` };
      } else if (d.need === 'claim_free') {
        const c = get("SELECT * FROM claims WHERE resource=? AND state IN ('active','reconcile_required')", d.ref);
        r = c ? { state: 'waiting', why: `${c.state} by ${c.owner}` } : { state: 'ready', why: 'no claim' };
      } else if (d.need === 'release_done') {
        const x = get('SELECT * FROM releases WHERE request_key=? OR CAST(id AS TEXT)=?', d.ref, d.ref);
        r = x?.state === 'done' ? { state: 'ready', why: 'release done', evidence: x.readback } : { state: 'waiting', why: `release ${x?.state ?? 'not requested'}` };
      } else if (['pr_merged', 'pr_deployed'].includes(d.need) && external) {
        r = await external(d).catch(e => ({ state: 'waiting', why: `check failed: ${e.message}` }));
      } else if (d.state !== 'ready') {
        r = { state: 'waiting', why: d.need === 'manual' || d.need === 'ticket_done' ? 'set by hand with dep set' : 'no evaluator' };
      }
      // Compare-and-set: a decision made while the check was pending (dep set dead/ready) wins.
      const u = run('UPDATE deps SET state=?, why=?, evidence=?, checked_at=?, version=version+1 WHERE id=? AND version=?',
        r.state, r.why ?? null, r.evidence ?? null, now(), d.id, d.version);
      if (!Number(u.changes)) {
        const cur = get('SELECT * FROM deps WHERE id=?', d.id);
        r = { state: cur.state, why: cur.why, evidence: cur.evidence, changed: true };
      }
    }
    out.push({ id: d.id, need: d.need, ref: d.ref, ...r });
  }
  return { work, ready: out.length > 0 && out.every(d => d.state === 'ready'), deps: out };
}

// ---------- release / TF / DDL / QA admission ----------

const SHA = /^[0-9a-f]{40}$/;
const relRow = id => {
  const r = get('SELECT * FROM releases WHERE id=?', Number(id));
  if (!r) throw refuse('not_found', `no release ${id}`);
  return { ...r, footprint: parse(r.footprint), content_prs: parse(r.content_prs), readback: parse(r.readback), tf_scope: parse(r.tf_scope) };
};
const touch = (id, set) => {
  const keys = Object.keys(set);
  run(`UPDATE releases SET ${keys.map(k => `${k}=?`).join(', ')}, version=version+1, updated_at=? WHERE id=?`, ...keys.map(k => set[k]), now(), id);
};
const overlap = (a, b) => a.some(x => b.includes(x));
const fingerprint = o => hash(o);

// Hooks supplied by the embedding process (crw). gateCheck(release) must resolve
// { prs: [{ pr, ok, evidence }] } with a positive, evidence-backed entry for every PR in content_prs.
export const hooks = { gateCheck: null };
export function configure(o = {}) {
  if ('gateCheck' in o) hooks.gateCheck = o.gateCheck;
  return { gateCheck: !!hooks.gateCheck };
}

async function runGates(r, gateCheck = hooks.gateCheck) {
  if (!DEPLOY_KINDS.includes(r.kind)) return { ok: true };
  if (!r.content_prs.length) return { ok: true, evidence: { empty_range: r.range_evidence } };
  if (typeof gateCheck !== 'function') return { ok: false, code: 'gate_unavailable', reason: 'no gateCheck hook configured' };
  let res;
  try { res = await gateCheck(r); } catch (e) { return { ok: false, code: 'gate_unavailable', reason: e.message }; }
  const got = new Map((res?.prs ?? []).map(p => [p.pr, p]));
  const missing = r.content_prs.filter(pr => !(got.get(pr)?.ok === true && got.get(pr)?.evidence));
  return missing.length
    ? { ok: false, code: 'gates_not_clear', reason: `no positive gate evidence for ${missing.join(', ')}`, missing }
    : { ok: true, evidence: r.content_prs.map(pr => ({ pr, evidence: got.get(pr).evidence })) };
}

export function tfRootGen(root) {
  return { root: need(root, 'root'), gen: get('SELECT gen FROM tf_roots WHERE root=?', root)?.gen ?? 0 };
}

export function releaseRequest(o = {}) {
  const { as, key, kind } = o;
  need(as, 'as'); need(key, 'key');
  if (!RELEASE_KINDS.includes(kind) || kind === 'qa_window') throw refuse('invalid', `kind must be one of ${RELEASE_KINDS.filter(k => k !== 'qa_window').join('|')}`);
  const env = need(o.env, 'env');
  evidence.requireEnv(env); // nothing could ever observe it to a terminal state
  const footprint = [...new Set(Array.isArray(o.footprint) ? o.footprint : list(o.footprint, []))];
  if (!footprint.length) throw refuse('invalid', 'footprint is required');
  let contentPrs = null, tfScope = null;
  if (DEPLOY_KINDS.includes(kind)) {
    need(o.repo, 'repo'); need(o.binary, 'binary');
    if (!SHA.test(o.sha ?? '')) throw refuse('invalid', 'sha must be a full 40-char revision');
    if (!SHA.test(o.runtimeSha ?? '')) throw refuse('invalid', 'runtimeSha (what is live now) must be a full 40-char revision');
    contentPrs = Array.isArray(o.contentPrs) ? o.contentPrs : list(o.contentPrs, null);
    if (!contentPrs) throw refuse('invalid', 'contentPrs (every PR in runtimeSha..sha) is required');
    if (!contentPrs.length && !o.rangeEvidence) throw refuse('invalid', 'an empty content range needs rangeEvidence');
    contentPrs = [...new Set(contentPrs)].sort();
  }
  if (kind === 'redispatch' && !(o.tag && o.digest)) throw refuse('invalid', 'redispatch binds the existing tag and digest');
  if (MANUAL_KINDS.includes(kind) && !evidence.EXEC_RULES[kind].identity(need(o.plan, 'plan')))
    throw refuse('invalid', kind === 'tf_apply' ? 'plan must be saved:<plan run id> or scope:<infra-only scope>' : 'plan must be <file>.sql[@checksum]');
  if (kind === 'tf_apply') {
    need(o.tfRoot, 'tfRoot');
    if (o.fullRoot) tfScope = { full_root: true };
    else {
      const targets = Array.isArray(o.targets) ? o.targets : list(o.targets, []);
      if (!targets.length) throw refuse('invalid', 'tf_apply needs targets or fullRoot');
      tfScope = { targets: [...new Set(targets)].sort() };
    }
    if (!Number.isInteger(o.rootGen) || o.rootGen < 0) throw refuse('invalid', 'rootGen (tf root gen at plan time) is required');
    if (!footprint.includes(`tf:${o.tfRoot}`)) footprint.push(`tf:${o.tfRoot}`);
  }
  const row = {
    requester: as, kind, environment: env, repo: o.repo ?? null, binary: o.binary ?? null, git_sha: o.sha ?? null,
    runtime_sha: o.runtimeSha ?? null, content_prs: json(contentPrs), range_evidence: o.rangeEvidence ?? null, tag: o.tag ?? null,
    image_digest: o.digest ?? null, plan_id: o.plan ?? null, footprint: json(footprint.sort()), risk: o.risk ?? 'ordinary',
    batch_id: o.batch ?? null, tf_root: o.tfRoot ?? null, tf_scope: json(tfScope), root_gen: kind === 'tf_apply' ? o.rootGen : null,
  };
  if (!['ordinary', 'stateful', 'high'].includes(row.risk)) throw refuse('invalid', 'risk must be ordinary|stateful|high');
  const fp = fingerprint(row);
  return tx(() => {
    const prev = get('SELECT id, fingerprint FROM releases WHERE request_key=?', key);
    if (prev) {
      if (prev.fingerprint !== fp) throw refuse('conflict', `release request ${key} exists with a different binding`, { status: 409, id: prev.id });
      return { release: relRow(prev.id), duplicate: true };
    }
    const t = now();
    const cols = Object.keys(row);
    const id = Number(run(`INSERT INTO releases (request_key,fingerprint,${cols.join(',')},state,created_at,updated_at) VALUES (?,?,${cols.map(() => '?').join(',')},'requested',?,?)`,
      key, fp, ...cols.map(k => row[k]), t, t).lastInsertRowid);
    return { release: relRow(id) };
  });
}

// Claims that block a mutation: expired leases on the footprint or env are first moved to reconcile_required.
function blockingClaim(env, footprint, owners) {
  const res = [...new Set([...footprint, `env:${env}`])];
  for (const resource of res) {
    const c = expire(get('SELECT * FROM claims WHERE resource=?', resource));
    if (c?.state === 'reconcile_required') return refuse('reconcile_required', `${resource} needs reconcile (${c.owner}, op ${c.op_ref ?? '-'})`, { owner: c.owner, op_ref: c.op_ref });
    if (c?.state === 'active' && !owners.includes(c.owner)) return refuse('claimed', `${resource} is held by ${c.owner}`, { owner: c.owner, fence: c.fence });
  }
  return null;
}
// Any open QA window holds its whole environment, expired or not, until master/release closes it.
const openQa = (env, exceptId = -1) => get("SELECT id, requester FROM releases WHERE kind='qa_window' AND state='running' AND environment=? AND id!=?", env, exceptId);

function tfChecks(r, at) {
  if (r.kind !== 'tf_apply') return null;
  if (r.tf_scope?.full_root && flag('tf_full_root_blocked')) return refuse('tf_full_root_blocked', 'full-root Terraform apply is blocked until master clears tf_full_root_blocked');
  const cur = tfRootGen(r.tf_root).gen;
  if (r.root_gen !== cur) {
    touch(r.id, { state: 'superseded', failure: `plan from root gen ${r.root_gen}, root is at ${cur} (${at})` });
    return refuse('stale_plan', `plan ${r.plan_id} was made at ${r.tf_root} gen ${r.root_gen}; root is now at gen ${cur}`);
  }
  return null;
}

function builtBlockers(r) {
  if (!r.repo) return [];
  return all("SELECT * FROM releases WHERE state='built_not_deployed' AND repo=? AND environment=? AND id!=?", r.repo, r.environment, r.id);
}

// `verify(release)` revalidates the pinned head (default: evidence.verifyHead). It must resolve {ok, reason?, transient?}.
export async function releaseAdmit(id, { as, manual = false, verify = evidence.verifyHead, gateCheck } = {}) {
  need(as, 'as');
  const r0 = relRow(id);
  if (r0.state === 'admitted' && r0.admitted_by === as) return { release: r0, duplicate: true };
  if (r0.state !== 'requested') throw refuse('bad_state', `release ${id} is ${r0.state}`);
  const v = r0.git_sha ? await verify(r0) : { ok: true };
  const g = await runGates(r0, gateCheck);
  return tx(() => {
    const r = relRow(id);
    if (r.version !== r0.version) throw refuse('changed', `release ${id} changed during admission; retry`);
    requireMode(`env:${r.environment}`);
    if (v.transient) throw refuse('verify_failed', `could not revalidate ${r.git_sha}: ${v.reason}`);
    if (!v.ok) {
      touch(r.id, { state: 'superseded', failure: `stale revision: ${v.reason ?? 'head check failed'}` });
      return refuse('stale_revision', `release ${id} ${r.git_sha} no longer valid: ${v.reason ?? ''}`.trim());
    }
    if (!g.ok) throw refuse(g.code, g.reason, { missing: g.missing });
    const tf = tfChecks(r, 'admit');
    if (tf) return tf;
    const qa = openQa(r.environment);
    if (qa) throw refuse('qa_window_open', `QA window #${qa.id} (${qa.requester}) holds ${r.environment}`, { blocking: qa.id });
    const busy = all("SELECT id, kind, footprint FROM releases WHERE id!=? AND state IN ('admitted','running') AND kind!='qa_window'", r.id)
      .find(x => overlap(parse(x.footprint), r.footprint));
    if (busy) throw refuse('footprint_busy', `overlaps ${busy.kind} #${busy.id}`, { blocking: busy.id });
    const held = blockingClaim(r.environment, r.footprint, [as, r.requester]);
    if (held) return held;
    const built = builtBlockers(r);
    let src = null;
    if (r.kind === 'redispatch') {
      src = built.find(b => b.binary === r.binary && b.tag === r.tag && b.image_digest === r.image_digest && b.git_sha === r.git_sha);
      if (!src) throw refuse('no_built_release', `no built_not_deployed ${r.binary} release in ${r.environment} with tag ${r.tag} and digest ${r.image_digest}`);
    } else if (built.length) {
      throw refuse('built_not_deployed', `release #${built[0].id} (${built[0].binary} ${built[0].tag}) is built but not deployed; redispatch it first`, { blocking: built[0].id });
    }
    const needsManual = r.risk !== 'ordinary' || MANUAL_KINDS.includes(r.kind) || r.kind === 'redispatch' || r.footprint.filter(f => f.startsWith('svc:')).length > 1;
    if (needsManual && !(manual && DEFAULTS.admitters.includes(as)))
      throw refuse('manual_admit_required', `${r.kind}/${r.risk} needs a manual admit by ${DEFAULTS.admitters.join('|')}`);
    // The fence is the admitter's env lease when it holds one, else a fresh admission fence for the env.
    const lease = get("SELECT * FROM claims WHERE resource=? AND state='active' AND owner=?", `env:${r.environment}`, as);
    let fence, fenceRes;
    if (lease) [fence, fenceRes] = [lease.fence, lease.resource];
    else {
      fenceRes = `release:${r.environment}`;
      run('INSERT INTO fences (resource,fence) VALUES (?,1) ON CONFLICT(resource) DO UPDATE SET fence=fence+1', fenceRes);
      fence = get('SELECT fence FROM fences WHERE resource=?', fenceRes).fence;
    }
    touch(r.id, { state: 'admitted', admitted_by: as, admitted_at: now(), fence, fence_resource: fenceRes, fence_owner: as,
      redispatch_of: src?.id ?? null, gate_evidence: json(g.evidence) });
    return { release: relRow(r.id) };
  });
}

// The caller restates the binding it is about to act on; any drift from the admitted row refuses.
export async function releaseStart(id, o = {}) {
  const { as, fence } = o;
  need(as, 'as'); need(fence, 'fence');
  const r0 = relRow(id);
  if (r0.state !== 'admitted') throw refuse('bad_state', `release ${id} is ${r0.state}`);
  const v = r0.git_sha ? await (o.verify ?? evidence.verifyHead)(r0) : { ok: true };
  const g = await runGates(r0, o.gateCheck);
  return tx(() => {
    const r = relRow(id);
    if (r.version !== r0.version) throw refuse('changed', `release ${id} changed during start checks; retry`);
    requireMode(`env:${r.environment}`, true);
    if (r.fence !== Number(fence)) throw refuse('stale_fence', `fence ${fence} is not the admission fence`);
    if (r.fence_resource?.startsWith('env:')) {
      const c = holder(r.fence_resource, r.fence_owner, r.fence);
      if (c instanceof Error) return c;
    }
    if (as !== r.requester && as !== r.admitted_by) throw refuse('forbidden', `${as} did not request or admit release ${id}`);
    // Fields fixed at request time must match; tag and digest may be bound now if still unset.
    for (const [k, col] of [['sha', 'git_sha'], ['repo', 'repo'], ['env', 'environment'], ['plan', 'plan_id'], ['tag', 'tag'], ['digest', 'image_digest']])
      if (o[k] !== undefined && (r[col] !== null || ['sha', 'repo', 'env', 'plan'].includes(k)) && o[k] !== r[col])
        throw refuse('binding_mismatch', `${k} ${o[k]} differs from admitted ${r[col]}`);
    if (v.transient) throw refuse('verify_failed', `could not revalidate ${r.git_sha}: ${v.reason}`);
    if (!v.ok) {
      touch(r.id, { state: 'superseded', failure: `head moved after admission: ${v.reason ?? ''}` });
      return refuse('head_moved', `release ${id} head moved after admission: ${v.reason ?? ''}`.trim());
    }
    if (!g.ok) throw refuse(g.code, g.reason, { missing: g.missing });
    const tf = tfChecks(r, 'start');
    if (tf) return tf;
    const qa = openQa(r.environment);
    if (qa) throw refuse('qa_window_open', `QA window #${qa.id} holds ${r.environment}`, { blocking: qa.id });
    const held = blockingClaim(r.environment, r.footprint, [r.admitted_by, r.requester]);
    if (held) return held;
    if (r.kind === 'redispatch') {
      const src = get("SELECT id FROM releases WHERE id=? AND state='built_not_deployed'", r.redispatch_of);
      if (!src) throw refuse('no_built_release', `source release #${r.redispatch_of} is no longer built_not_deployed`);
    }
    const set = { state: 'running', gate_evidence: json(g.evidence) };
    for (const [k, col] of [['tag', 'tag'], ['digest', 'image_digest'], ['releaseRun', 'release_run'], ['deployRun', 'deploy_run'], ['tfRun', 'tf_run']])
      if (o[k] !== undefined) set[col] = o[k];
    touch(r.id, set);
    // Any started mutation that declares a Terraform root invalidates plans made against that root.
    for (const root of r.footprint.filter(f => f.startsWith('tf:')).map(f => f.slice(3)))
      run('INSERT INTO tf_roots (root,gen) VALUES (?,1) ON CONFLICT(root) DO UPDATE SET gen=gen+1', root);
    if (r.kind === 'redispatch') touch(r.redispatch_of, { state: 'superseded', outcome: `redispatched as #${r.id}` });
    return { release: relRow(r.id) };
  });
}

// Records run ids or a digest found after dispatch. On a built_not_deployed row an admitter may bind the
// digest or downstream run from evidence (so it can be redispatched); the row stays built_not_deployed.
export function releaseRecord(id, o = {}) {
  return tx(() => {
    const r = relRow(id);
    const built = r.state === 'built_not_deployed';
    if (built) {
      if (!DEFAULTS.admitters.includes(o.as)) throw refuse('forbidden', `only ${DEFAULTS.admitters.join('|')} may record on a built release`);
      need(o.evidence, 'evidence');
    } else {
      if (!['running', 'admitted'].includes(r.state)) throw refuse('bad_state', `release ${id} is ${r.state}`);
      if (r.fence !== Number(o.fence)) throw refuse('stale_fence', `fence ${o.fence} is not the admission fence`);
    }
    const set = {};
    for (const [k, col] of [['releaseRun', 'release_run'], ['deployRun', 'deploy_run'], ['tfRun', 'tf_run'], ['digest', 'image_digest']]) {
      if (o[k] === undefined) continue;
      if (r[col] && r[col] !== o[k]) throw refuse('binding_mismatch', `${col} already ${r[col]}`);
      if (built && !['digest', 'deployRun'].includes(k)) throw refuse('invalid', `${k} cannot be recorded on a built release`);
      set[col] = o[k];
    }
    if (built && Object.keys(set).length) set.outcome = `recorded by ${o.as}: ${o.evidence}`;
    if (Object.keys(set).length) touch(r.id, set);
    return { release: relRow(r.id) };
  });
}

// `observe(release)` resolves {state, readback?, failure?, outcome?, digest?}; see evidence.observeRelease.
// The result is applied only if the row did not change while the observer ran.
export async function releaseObserve(id, { observe = evidence.observeRelease } = {}) {
  const r = relRow(id);
  if (r.state !== 'running') return { release: r, unchanged: true };
  const o = await observe(r);
  if (!o || !['done', 'failed', 'built_not_deployed'].includes(o.state)) {
    const note = `${o?.state ?? 'unknown'}: ${o?.why ?? 'no result'}`;
    run('UPDATE releases SET observed_at=?, observe_note=? WHERE id=?', now(), note, r.id);
    return { release: relRow(id), pending: note };
  }
  return tx(() => {
    const cur = relRow(id);
    if (cur.version !== r.version) return { release: cur, pending: 'release changed while observing; observe again' };
    if (o.digest && cur.image_digest && o.digest !== cur.image_digest)
      throw refuse('binding_mismatch', `observed digest ${o.digest} differs from bound ${cur.image_digest}`);
    touch(r.id, { state: o.state, readback: json(o.readback), failure: o.failure ?? null, outcome: o.outcome ?? o.state, observed_at: now(),
      ...(o.digest && !cur.image_digest ? { image_digest: o.digest } : {}) });
    return { release: relRow(r.id) };
  });
}

export function releaseCancel(id, { as, note } = {}) {
  return tx(() => {
    const r = relRow(id);
    // A built_not_deployed release blocks new tags for its repo until it is redispatched or an admitter drops it.
    const allowed = r.state === 'built_not_deployed' ? DEFAULTS.admitters : [r.requester, ...DEFAULTS.admitters];
    if (!['requested', 'admitted', 'built_not_deployed'].includes(r.state)) throw refuse('bad_state', `release ${id} is ${r.state}`);
    if (!allowed.includes(as)) throw refuse('forbidden', `${as} may not cancel release ${id}`);
    touch(r.id, { state: 'cancelled', outcome: note ?? 'cancelled' });
    return { release: relRow(r.id) };
  });
}

export function releaseList({ state, env } = {}) {
  return { releases: all('SELECT id FROM releases WHERE (? IS NULL OR state=?) AND (? IS NULL OR environment=?) ORDER BY id', state ?? null, state ?? null, env ?? null, env ?? null).map(x => relRow(x.id)) };
}

// A QA window is a release row of kind qa_window that goes straight to running. It holds its whole
// environment against every mutation (and every mutation holds it off), whatever the footprint strings.
// Expiry only raises attention; it never frees the environment on its own.
export function qaOpen({ as, env, footprint, ttl, key } = {}) {
  need(as, 'as'); need(env, 'env');
  const fp = [...new Set([...(Array.isArray(footprint) ? footprint : list(footprint, [])), `env:${env}`])].sort();
  const secs = parseTtl(ttl, 4 * 3600);
  const f = fingerprint({ kind: 'qa_window', requester: as, environment: env, footprint: fp, ttl: secs });
  return tx(() => {
    const prev = key && get('SELECT id, fingerprint FROM releases WHERE request_key=?', key);
    if (prev) {
      if (prev.fingerprint !== f) throw refuse('conflict', `request ${key} exists with a different binding`, { status: 409, id: prev.id });
      return { release: relRow(prev.id), duplicate: true };
    }
    requireMode(`env:${env}`);
    const busy = all("SELECT id, kind, footprint FROM releases WHERE state IN ('admitted','running') AND (environment=? OR kind='qa_window')", env)
      .find(x => x.kind !== 'qa_window' || overlap(parse(x.footprint), fp));
    if (busy) throw refuse(busy.kind === 'qa_window' ? 'footprint_busy' : 'env_busy', `${env} has ${busy.kind} #${busy.id} in flight`, { blocking: busy.id });
    const held = blockingClaim(env, fp, [as]);
    if (held) return held;
    const t = now();
    const id = Number(run(`INSERT INTO releases (request_key,fingerprint,requester,kind,environment,footprint,state,admitted_by,admitted_at,readback,created_at,updated_at)
      VALUES (?,?,?,'qa_window',?,?,'running',?,?,?,?,?)`, key ?? `qa:${as}:${env}:${t}:${f.slice(0, 8)}`, f, as, env, json(fp), as, t, json({ until: t + secs }), t, t).lastInsertRowid);
    return { release: relRow(id) };
  });
}

export function qaClose(id, { as, note } = {}) {
  return tx(() => {
    const r = relRow(id);
    if (r.kind !== 'qa_window' || r.state !== 'running') throw refuse('bad_state', `#${id} is not an open QA window`);
    if (![r.requester, ...DEFAULTS.admitters].includes(as)) throw refuse('forbidden', `${as} may not close QA window ${id}`);
    touch(r.id, { state: 'done', outcome: note ?? 'closed' });
    return { release: relRow(r.id) };
  });
}

// ---------- architecture writer queue ----------

export const archKey = (repos, pins, prefix = 'crw-drift') => `${prefix}:${[...repos].sort().join(',')}:${hash(pins).slice(0, 16)}`;

export function archRequest(o = {}) {
  need(o.as, 'as');
  if (!ARCH_KINDS.includes(o.kind)) throw refuse('invalid', `kind must be one of ${ARCH_KINDS.join('|')}`);
  const repos = Array.isArray(o.repos) ? o.repos : list(o.repos, []);
  const pins = o.pins ?? null;
  const key = o.key ?? archKey(repos, pins ?? {}, o.kind);
  const row = { kind: o.kind, repos: json([...repos].sort()), pins: json(canon(pins)), packet_path: o.packet ?? null, summary: o.summary ?? null };
  return tx(() => {
    const prev = get('SELECT * FROM arch_requests WHERE request_key=?', key);
    if (prev) {
      if (['kind', 'repos', 'pins'].some(k => prev[k] !== row[k])) throw refuse('conflict', `arch request ${key} exists with different content`, { status: 409, id: prev.id });
      return { request: prev, duplicate: true };
    }
    const t = now();
    const id = Number(run(`INSERT INTO arch_requests (request_key,requester,kind,repos,pins,packet_path,summary,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'queued',?,?)`, key, o.as, row.kind, row.repos, row.pins, row.packet_path, row.summary, t, t).lastInsertRowid);
    return { request: get('SELECT * FROM arch_requests WHERE id=?', id) };
  });
}

export const ARCH_RESOURCE = 'arch:broker';

function archStep(id, as, fence, from, set) {
  return tx(() => {
    const c = holder(ARCH_RESOURCE, as, fence);
    if (c instanceof Error) return c;
    const a = get('SELECT * FROM arch_requests WHERE id=?', Number(id));
    if (!a) throw refuse('not_found', `no arch request ${id}`);
    if (from === 'queued' && a.state === 'taken' && a.taken_by === as) return { request: a, duplicate: true };
    if (a.state !== from) throw refuse('bad_state', `arch request ${id} is ${a.state}`);
    if (from === 'taken' && (a.taken_by !== as || a.fence !== Number(fence)))
      throw refuse('forbidden', `arch request ${id} is bound to ${a.taken_by} fence ${a.fence}; use arch transfer after reconcile`);
    const keys = Object.keys(set);
    run(`UPDATE arch_requests SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...keys.map(k => set[k]), now(), a.id);
    return { request: get('SELECT * FROM arch_requests WHERE id=?', a.id) };
  });
}
export const archTake = (id, { as, fence } = {}) => archStep(id, as, fence, 'queued', { state: 'taken', taken_by: as, fence: Number(fence) });
export const archDone = (id, { as, fence, commits, note } = {}) =>
  archStep(id, as, fence, 'taken', { state: 'done', result_commits: json(Array.isArray(commits) ? commits : list(commits, [])), result_note: note ?? null });
export const archReject = (id, { as, fence, note, superseded } = {}) =>
  archStep(id, as, fence, 'taken', { state: superseded ? 'superseded' : 'rejected', result_note: need(note, 'note') });
// Hands a taken request to the current arch:broker holder once the fence it was taken under has ended
// cleanly: released by its owner, or reconciled as not_started / rolled_back.
export function archTransfer(id, { as, fence } = {}) {
  return tx(() => {
    const c = holder(ARCH_RESOURCE, as, fence);
    if (c instanceof Error) return c;
    const a = get('SELECT * FROM arch_requests WHERE id=?', Number(id));
    if (!a) throw refuse('not_found', `no arch request ${id}`);
    if (a.state !== 'taken') throw refuse('bad_state', `arch request ${id} is ${a.state}`);
    if (a.taken_by === as && a.fence === Number(fence)) return { request: a, duplicate: true };
    const prev = get('SELECT * FROM claim_history WHERE resource=? AND fence=?', ARCH_RESOURCE, a.fence);
    const ok = prev && (prev.state === 'released' || (prev.state === 'reconciled' && ['not_started', 'rolled_back'].includes(prev.reconcile_outcome)));
    if (!ok)
      throw refuse('not_reconciled', `fence ${a.fence} of ${a.taken_by} was neither released nor reconciled as not_started/rolled_back`,
        { previous: prev ? { state: prev.state, outcome: prev.reconcile_outcome } : null });
    run('UPDATE arch_requests SET taken_by=?, fence=?, result_note=?, updated_at=? WHERE id=?', as, Number(fence),
      `transferred from ${a.taken_by} fence ${a.fence} (${prev.state}${prev.reconcile_outcome ? ` ${prev.reconcile_outcome} by ${prev.reconcile_by}: ${prev.reconcile_evidence}` : ''})`, now(), a.id);
    return { request: get('SELECT * FROM arch_requests WHERE id=?', a.id) };
  });
}
export const archList = ({ state } = {}) => ({ requests: all('SELECT * FROM arch_requests WHERE (? IS NULL OR state=?) ORDER BY id', state ?? null, state ?? null) });

// ---------- approval provenance ----------

const RELAY = /^\s*(\[crw\]|\[coord |CRPKO_PIPELINE_AUTOMATION:)/;
// A Robob message may carry human authority only when the owner typed it in the web or mobile app.
export function approvalProvenance(m, { sources = DEFAULTS.approvalSources } = {}) {
  const role = m?.role ?? null, createdBy = m?.createdBy ?? null, creationSource = m?.creationSource ?? null;
  const base = { messageId: m?.messageId ?? m?.id ?? null, createdBy, creationSource };
  if (role !== 'user') return { verified: false, reason: 'not a user message', ...base };
  if (createdBy !== 'user') return { verified: false, reason: `createdBy ${createdBy}`, ...base };
  if (!sources.includes(creationSource)) return { verified: false, reason: `creationSource ${creationSource}`, ...base };
  if (RELAY.test(m.text ?? '')) return { verified: false, reason: 'relayed automation text', ...base };
  return { verified: true, ...base };
}

// ---------- attention / status ----------

// Robob 'waiting' still has background work that may wake the thread again; only 'idle' is drained.
export const threadDrained = state => state === 'idle';

export async function drainReport({ threadState, scope } = {}) {
  const g = gate(scope);
  const inflight = {
    releases: all("SELECT id, kind, environment, state, requester FROM releases WHERE state IN ('admitted','running')"),
    claims: all("SELECT resource, owner, fence, state, op_ref FROM claims WHERE state IN ('active','reconcile_required')"),
    deliveries: get("SELECT COUNT(*) n FROM deliveries WHERE status='pending'").n,
    threads: [],
  };
  // Thread actors that cannot be checked count as not drained.
  for (const a of all("SELECT * FROM actors WHERE kind='thread' AND thread_id IS NOT NULL")) {
    const state = threadState ? await threadState(a.thread_id).catch(e => `unknown: ${e.message}`) : 'unknown: no control API';
    if (!threadDrained(state)) inflight.threads.push({ actor: a.id, thread: a.thread_id, state });
  }
  const drained = !inflight.releases.length && !inflight.claims.length && !inflight.deliveries && !inflight.threads.length;
  return { mode: g.mode, drained, inflight };
}

export function attention({ unackedAfter = DEFAULTS.unackedAfter } = {}) {
  const t = now();
  return {
    unacked: all(`SELECT d.event_seq seq, d.recipient, d.status, d.sent_at, d.reminded, e.channel_id, e.summary FROM deliveries d JOIN events e ON e.seq=d.event_seq
      WHERE d.status IN ('sent','skipped') AND COALESCE(d.sent_at, e.created_at)<=?`, t - unackedAfter),
    failed_deliveries: all('SELECT event_seq seq, recipient, attempts, last_error FROM deliveries WHERE status=?', 'failed'),
    reconcile_required: all("SELECT resource, owner, fence, op_ref, reconcile_outcome FROM claims WHERE state='reconcile_required' OR (state='active' AND lease_until<=?)", t),
    releases: all(`SELECT id, kind, environment, repo, binary, tag, state, failure FROM releases
      WHERE state IN ('built_not_deployed','failed') OR (state='superseded' AND outcome IS NULL AND updated_at>?)
        OR (state='requested' AND created_at<=?) OR (state='admitted' AND admitted_at<=?)`, t - 7 * 86400, t - 3600, t - 3600),
    unobserved: all("SELECT id, kind, environment, observed_at, observe_note FROM releases WHERE state='running' AND kind!='qa_window' AND observe_note LIKE 'unknown:%'"),
    expired_qa_windows: all("SELECT id, requester, environment, readback FROM releases WHERE kind='qa_window' AND state='running'")
      .filter(q => (parse(q.readback)?.until ?? Infinity) <= t),
    arch_queued: all("SELECT id, kind, requester, summary FROM arch_requests WHERE state='queued'"),
  };
}

export function status() {
  const count = (tbl, col) => Object.fromEntries(all(`SELECT ${col} k, COUNT(*) n FROM ${tbl} GROUP BY ${col}`).map(r => [r.k, r.n]));
  return {
    control: all('SELECT * FROM control ORDER BY k'),
    actors: all('SELECT * FROM actors ORDER BY id'),
    channels: count('channels', 'status'), deliveries: count('deliveries', 'status'), claims: count('claims', 'state'),
    releases: count('releases', 'state'), arch_requests: count('arch_requests', 'state'), deps: count('deps', 'state'),
  };
}

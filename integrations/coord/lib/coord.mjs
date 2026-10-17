import { createHash } from 'node:crypto';
import { tx, get, all, run, CoordError, setOnOpen } from './db.mjs';
import * as evidence from './evidence.mjs';
import * as forward from './forward.mjs';

export { evidence, CoordError };
export { messagingTarget } from './forward.mjs';

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

// ---------- environment identities ----------

// One spelling per environment, wherever an environment enters (claim env, release env, QA env,
// pause/drain scopes, event env, filters, CLI flags): lowercase dev | staging | prod | ephemeral:<name>.
// env_required (missing/blank), env_invalid (malformed), env_unsupported (not supported: '*', or any
// environment without an evidence source unless `supported: false`, which only checks the spelling).
const ENV_FORM = /^[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?$/;
export function canonicalEnv(env, { supported = true } = {}) {
  if (env === undefined || env === null || (typeof env === 'string' && !env.trim())) throw refuse('env_required', 'environment is missing or blank');
  if (typeof env !== 'string') throw refuse('env_invalid', `environment ${JSON.stringify(env)} must be a string`);
  if (env === '*') throw refuse('env_unsupported', "'*' is not an environment; name one");
  const e = env.toLowerCase();
  if (!ENV_FORM.test(e)) throw refuse('env_invalid', `environment ${JSON.stringify(env)} is malformed`);
  if (supported && !evidence.SUPPORTED_ENVS.includes(e)) throw refuse('env_unsupported', `environment ${e} is not supported (${evidence.SUPPORTED_ENVS.join(', ')})`);
  return e;
}
// Pause/drain scopes: env:<e> (canonical environment) or a lowercase name such as `crw`; anything else is
// scope_invalid. Empty means the global scope.
export function canonicalScope(scope, { supported = true } = {}) {
  if (scope === undefined || scope === null || scope === '') return null;
  if (typeof scope !== 'string') throw refuse('scope_invalid', `scope ${JSON.stringify(scope)} must be a string`);
  if (/^env:/i.test(scope)) return `env:${canonicalEnv(scope.slice(4), { supported })}`;
  const k = scope.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(k)) throw refuse('scope_invalid', `scope ${JSON.stringify(scope)} must be env:<e> or a name`);
  return k;
}

// ---------- control: pause / drain / flags ----------

const RANK = { run: 0, drain: 1, pause: 2 };

export function setMode(mode, { scope, as, reason } = {}) {
  if (!(mode in RANK)) throw refuse('invalid', `mode must be run|drain|pause`);
  need(as, 'as');
  const sc = canonicalScope(scope);
  const k = sc ? `mode:${sc}` : 'mode';
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
  scope = canonicalScope(scope, { supported: false }) ?? undefined;
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

// Messaging mode. `messaging=coord` (default, also the rollback) keeps post/inbox/ack on coord.db and the pump rings.
// `messaging=robob` forwards post/inbox/ack to the Robob missions API (lib/forward.mjs) for the mission in
// `messaging:mission`, and the pump stops ringing. Claims, QA windows, releases, deps and the arch queue stay here.
export const MESSAGING_MODES = ['coord', 'robob'];
export const MESSAGING_SETTERS = ['master'];
export function messaging() {
  const r = get("SELECT * FROM control WHERE k='messaging'");
  return {
    mode: r?.v === 'robob' ? 'robob' : 'coord',
    mission: get("SELECT v FROM control WHERE k='messaging:mission'")?.v ?? null,
    set_by: r?.set_by ?? null, set_at: r?.set_at ?? null, reason: r?.reason ?? null,
  };
}
export function setMessaging(mode, { as, reason, mission } = {}) {
  if (!MESSAGING_MODES.includes(mode)) throw refuse('invalid', `messaging must be ${MESSAGING_MODES.join('|')}`);
  need(as, 'as');
  if (!MESSAGING_SETTERS.includes(as)) throw refuse('forbidden', `only ${MESSAGING_SETTERS.join('|')} may switch messaging`);
  const upsert = (k, v) => run('INSERT INTO control (k,v,set_by,set_at,reason) VALUES (?,?,?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, set_by=excluded.set_by, set_at=excluded.set_at, reason=excluded.reason',
    k, v, as, now(), reason ?? null);
  return tx(() => {
    if (mission !== undefined && mission !== null && mission !== '') upsert('messaging:mission', String(mission).trim());
    if (mode === 'robob' && !messaging().mission) throw refuse('mission_required', 'messaging=robob needs --mission (the Robob mission the coord channels were imported into)');
    upsert('messaging', mode);
    return messaging();
  });
}

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

// Creates the actor if missing; an existing actor (and its thread binding) is left alone. One insert-if-
// absent, so a registration that wins concurrently is never overwritten. A new actor has no deliveries
// (posting requires the actor), so nothing is retargeted.
export function ensureActor(id, { thread, kind } = {}) {
  need(id, 'actor id');
  const k = kind ?? (thread ? 'thread' : 'process');
  if (!['thread', 'process'].includes(k)) throw refuse('invalid', 'kind must be thread|process');
  if (k === 'thread' && !thread) throw refuse('invalid', 'thread actors need --thread');
  return tx(() => {
    const ins = run('INSERT INTO actors (id,kind,thread_id,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING', id, k, k === 'thread' ? thread : null, now());
    return { actor: actor(id), ...(Number(ins.changes) ? { created: true } : { existing: true }) };
  });
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
// post, inbox and ack stay synchronous on coord.db. With messaging=robob they return a Promise of the same shape.
const forwarding = () => {
  const m = messaging();
  if (m.mode !== 'robob') return null;
  if (!m.mission) throw refuse('mission_required', 'messaging=robob but no messaging:mission row; run coord messaging robob --mission ID');
  return m;
};

export const deliveryId = (eventKey, recipient) => `coord:${createHash('sha256').update(JSON.stringify([eventKey, recipient])).digest('hex')}`;

export function post(channel, o = {}) {
  const { as, kind, key, summary } = o;
  need(as, 'as'); need(key, 'key'); need(summary, 'summary');
  if (!EVENT_KINDS.includes(kind)) throw refuse('invalid', `kind must be one of ${EVENT_KINDS.join('|')}`);
  const to = Array.isArray(o.to) ? o.to : list(o.to, null);
  const ev = o.env === undefined || o.env === null ? null : canonicalEnv(o.env, { supported: false });
  const fields = { channel, kind, sender: as, work: o.work, env: ev ?? undefined, rev: o.rev, authority: o.authority, summary, body: o.body, reply_to: o.replyTo, to };
  const h = hash(fields);
  const m = forwarding();
  if (m) return forward.post({ mission: m.mission, channel, as, kind, key, hash: h, summary, to: to ?? null, work: o.work ?? null,
    env: ev, rev: o.rev ?? null, authority: o.authority ?? null, body: o.body ?? null, replyTo: o.replyTo ?? null });
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
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, key, h, channel, kind, as, o.work ?? null, ev, o.rev ?? null, o.authority ?? null, summary,
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
  const m = forwarding();
  if (m) return forward.inbox({ mission: m.mission, as, unacked: !!unacked, after: Number(after) || 0, limit: Number(limit) });
  return {
    events: all(`SELECT e.*, d.status delivery, d.acked_at FROM deliveries d JOIN events e ON e.seq=d.event_seq
      WHERE d.recipient=? AND e.seq>? ${unacked ? "AND d.status!='acked'" : ''} ORDER BY e.seq LIMIT ?`, as, Number(after) || 0, Number(limit))
      .map(e => ({ ...e, body_json: parse(e.body_json) })),
  };
}

export function ack(as, refs = []) {
  need(as, 'as');
  const m = forwarding();
  if (m) return forward.ack({ mission: m.mission, as, refs: refs.map(String) });
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

// Resource keys: one canonical spelling per resource, used by every entry point that takes a key
// (claim, check, renew, release, reconcile, claim_free deps, release and QA footprints, CLI).
// repo:<owner>/<name> and pr:<owner>/<name>#<n> lowercase owner/name (GitHub is case-insensitive);
// svc:<binary>, tf:<root> and env:<e> are lowercase identifiers; other kinds keep their value as given.
// Anything else is refused (resource_invalid) rather than guessed.
const ID = /^[a-z0-9][a-z0-9-]*$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;
export function canonicalResource(key) {
  const bad = why => refuse('resource_invalid', `resource ${JSON.stringify(key)}: ${why}`);
  if (typeof key !== 'string' || !key) throw bad('must be a non-empty string');
  if (/[\s\u0000-\u001f\u007f]/.test(key)) throw bad('no whitespace or control characters');
  const i = key.indexOf(':');
  if (i < 1) throw bad('must be <kind>:<value>');
  const kind = key.slice(0, i).toLowerCase(), value = key.slice(i + 1);
  if (!/^[a-z][a-z0-9_-]*$/.test(kind)) throw bad('kind must be letters, digits, _ or -');
  if (kind === 'env') {
    // env: and env:* reach claimEnv, which refuses them as env_required / env_unsupported.
    if (value === '' || value === '*') return `env:${value}`;
    // dev | staging | prod | ephemeral:<name> (the release environment grammar).
    if (!/^[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?$/.test(value.toLowerCase())) throw bad('env must be an environment name');
    return `env:${value.toLowerCase()}`;
  }
  if (kind === 'svc' || kind === 'tf') {
    if (!ID.test(value.toLowerCase())) throw bad(`${kind} must be a lowercase name`);
    return `${kind}:${value.toLowerCase()}`;
  }
  if (kind === 'repo') {
    if (!REPO.test(value)) throw bad('repo must be <owner>/<name>');
    return `repo:${value.toLowerCase()}`;
  }
  if (kind === 'pr') {
    const m = /^([A-Za-z0-9][A-Za-z0-9_.\/-]*)#([1-9][0-9]*)$/.exec(value);
    if (!m) throw bad('pr must be <repo>#<number>');
    return `pr:${m[1].toLowerCase()}#${m[2]}`;
  }
  if (!value) throw bad('value is empty');
  return `${kind}:${value}`;
}
const canonList = keys => [...new Set(keys.map(canonicalResource))];

// Claims on these resource kinds coordinate work, not environment mutations; every other kind
// (env:, svc:, repo:, tf:, ch:, ...) is a mutation claim scoped to exactly one supported environment.
const NON_MUTATION = ['pr', 'ticket', 'files', 'arch', 'channel', 'work'];
// The environment a resource names by itself: env:<e>, and Terraform roots tf:<e> / tf:<e>-<suffix>
// (dev, dev-risk-liquidation and dev-core-capacity are dev). Null when the resource does not say.
function intrinsicEnv(resource) {
  if (resource.startsWith('env:')) return resource.slice(4);
  return /^tf:(dev|staging|prod)(?:-[a-z0-9-]+)?$/.exec(resource)?.[1] ?? null;
}
// Mutation scope of a claim: the resource's own environment, else the caller's explicit `env`. It must
// be one concrete supported environment: env_required (missing/blank), env_unsupported (unsupported or
// '*'), env_mismatch (contradicts the resource's own environment). Coordination claims have no scope.
export function claimEnv(resource, env) {
  if (NON_MUTATION.includes(resource.split(':')[0])) return null;
  const own = intrinsicEnv(resource);
  if (own !== null && !own.trim()) throw refuse('env_required', `${resource} names no environment`);
  let given = null;
  if (env !== undefined && env !== null) given = canonicalEnv(env, { supported: false });
  if (own && given && given !== own) throw refuse('env_mismatch', `${resource} is a ${own} resource, not ${given}`);
  const scope = own ?? given;
  if (!scope) throw refuse('env_required', `${resource} is a mutation claim: pass the environment it acts on (env)`);
  if (!evidence.SUPPORTED_ENVS.includes(scope)) throw refuse('env_unsupported', `${resource}: environment ${scope} is not supported (${evidence.SUPPORTED_ENVS.join(', ')})`);
  return scope;
}
const envMatch = (a, b) => a === b;

// Every holder of a mutation claim in `env`: the open QA window or the first conflicting release.
function envHolder(resource, env, fence = null, owner = null) {
  if (env === null) return releaseOn(resource, fence, owner);
  const qa = all("SELECT id, environment FROM releases WHERE kind='qa_window' AND state='running'").find(q => envMatch(q.environment, env));
  if (qa) return refuse('qa_window_open', `QA window #${qa.id} holds ${qa.environment}; mutation claims wait for it to close`, { blocking: qa.id });
  const rel = releaseOn(resource, fence, owner, env);
  return rel && refuse('release_in_flight', `${rel.kind} #${rel.id} (${rel.state}) holds ${resource}`, { blocking: rel.id });
}

// Pause/drain gates a claim must pass: global, plus its environment's.
const requireClaimMode = scope => requireMode(scope === null ? undefined : `env:${scope}`);

// Claim-vs-claim overlap beyond the same resource: env:<e> covers every mutation claim scoped to <e>,
// and every such claim is covered by env:<e>. Expired leases still count (reconcile first).
// There is no same-operation association between claims, so the owner does not matter.
function overlappingClaim(resource, scope) {
  if (scope === null) return null;
  const isEnv = resource.startsWith('env:');
  for (const row of all("SELECT * FROM claims WHERE resource!=? AND env IS NOT NULL AND state IN ('active','reconcile_required')", resource)) {
    const c = expire(row);
    const covers = isEnv ? envMatch(c.env, scope) : c.resource.startsWith('env:') && envMatch(c.env, scope);
    if (!covers) continue;
    if (c.state === 'reconcile_required') return refuse('reconcile_required', `${c.resource} (${c.owner}) overlaps ${resource} and needs reconcile`, { owner: c.owner, resource: c.resource, op_ref: c.op_ref });
    return refuse('claimed', `${c.resource} held by ${c.owner} overlaps ${resource}`, { owner: c.owner, resource: c.resource, fence: c.fence });
  }
  return null;
}

export function claim(resource, { as, ttl, purpose, op, env } = {}) {
  need(resource, 'resource'); need(as, 'as');
  resource = canonicalResource(resource);
  const secs = parseTtl(ttl);
  const scope = claimEnv(resource, env);
  return tx(() => {
    requireClaimMode(scope);
    const held = envHolder(resource, scope);
    if (held instanceof Error) throw held;
    if (held) throw refuse('release_in_flight', `${held.kind} #${held.id} (${held.state}) holds ${resource}`, { blocking: held.id });
    const overlap_ = overlappingClaim(resource, scope);
    if (overlap_) return overlap_;
    const c = expire(get('SELECT * FROM claims WHERE resource=?', resource));
    if (c?.state === 'reconcile_required') return reconcileErr(c);
    if (c?.state === 'active') throw refuse('held', `${resource} is held by ${c.owner}`, { owner: c.owner, fence: c.fence, lease_until: c.lease_until });
    if (c) run(`INSERT OR IGNORE INTO claim_history (resource,fence,owner,state,op_ref,reconcile_by,reconcile_outcome,reconcile_evidence,ended_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, c.resource, c.fence, c.owner, c.state, c.op_ref, c.reconcile_by, c.reconcile_outcome, c.reconcile_evidence, c.released_at ?? now());
    run('INSERT INTO fences (resource,fence) VALUES (?,1) ON CONFLICT(resource) DO UPDATE SET fence=fence+1', resource);
    const fence = get('SELECT fence FROM fences WHERE resource=?', resource).fence;
    const t = now();
    run(`INSERT OR REPLACE INTO claims (resource,owner,fence,state,lease_until,purpose,op_ref,claimed_at,renewed_at,env)
      VALUES (?,?,?,'active',?,?,?,?,?,?)`, resource, as, fence, t + secs, purpose ?? null, op ?? null, t, t, scope);
    bumpRoots(claimRoots(resource, scope));
    return { resource, fence, lease_until: t + secs, env: scope };
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

// Admitted/running mutations holding `resource`, other than ones whose admission relied on exactly this
// claim fence (the same operation). An env: resource is held by every mutation in that environment, and
// an env-exclusive mutation holds every mutation claim (`claimScope`) in its environment.
function releaseOn(resource, fence = null, owner = null, claimScope = null) {
  const env = resource.startsWith('env:') ? resource.slice(4) : null;
  return all("SELECT id, kind, state, environment, env_exclusive, footprint, claim_fences FROM releases WHERE state IN ('admitted','running') AND kind!='qa_window'")
    .find(r => {
      const holds = env ? r.environment === env : parse(r.footprint).includes(resource);
      if (!holds && !(r.env_exclusive && claimScope !== null && envMatch(r.environment, claimScope))) return false;
      const relied = parse(r.claim_fences)?.[resource];
      return !(fence !== null && relied && relied.fence === Number(fence) && relied.owner === owner);
    }) ?? null;
}

export function check(resource, { as, fence } = {}) {
  resource = canonicalResource(resource);
  return tx(() => {
    const cur = get('SELECT env FROM claims WHERE resource=?', resource);
    if (!cur) return refuse('not_held', `${resource} is not claimed`);
    const scope = cur.env;
    const held = envHolder(resource, scope, fence, as);
    if (held instanceof Error) throw held;
    if (held) throw refuse('release_in_flight', `${held.kind} #${held.id} (${held.state}) holds ${resource}`, { blocking: held.id });
    const overlap_ = overlappingClaim(resource, scope);
    if (overlap_) return overlap_;
    const c = holder(resource, as, fence);
    return c instanceof Error ? c : { resource, owner: c.owner, fence: c.fence, lease_until: c.lease_until };
  });
}

export function renew(resource, { as, fence, ttl, op } = {}) {
  resource = canonicalResource(resource);
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
  resource = canonicalResource(resource);
  return tx(() => {
    const c = holder(resource, as, fence);
    if (c instanceof Error) return c;
    run("UPDATE claims SET state='released', released_at=?, note=? WHERE resource=?", now(), note ?? null, resource);
    bumpRoots(claimRoots(resource, c.env));
    return { resource, fence: c.fence, state: 'released' };
  });
}

// Reconciles exactly the expired claim with `fence`. A retry for a fence that was already reconciled
// returns that historical result; any other fence mismatch is stale_fence and the current claim is untouched.
export function reconcile(resource, { as, fence, outcome, evidence } = {}) {
  resource = canonicalResource(resource);
  need(as, 'as'); need(evidence, 'evidence'); need(fence, 'fence');
  const f = Number(fence);
  if (!Number.isInteger(f) || f < 1) throw refuse('invalid', 'fence must be a positive integer');
  if (!['done', 'not_started', 'rolled_back', 'still_running'].includes(outcome))
    throw refuse('invalid', 'outcome must be done|not_started|rolled_back|still_running');
  if (!DEFAULTS.reconcilers.includes(as)) throw refuse('forbidden', `${as} may not reconcile (allowed: ${DEFAULTS.reconcilers.join(',')})`);
  return tx(() => {
    const c = expire(get('SELECT * FROM claims WHERE resource=?', resource));
    const done = c?.fence === f && c.state === 'reconciled' ? c
      : get("SELECT * FROM claim_history WHERE resource=? AND fence=? AND state='reconciled'", resource, f);
    if (done) return { resource, fence: f, state: 'reconciled', outcome: done.reconcile_outcome, historical: true };
    if (c?.fence !== f) throw refuse('stale_fence', `${resource} fence ${f} is not the current claim (current ${c?.fence ?? 'none'}) and was not reconciled`, { fence: c?.fence ?? null });
    if (c.state !== 'reconcile_required') throw refuse('not_reconcilable', `${resource} fence ${f} is ${c.state}`);
    const state = outcome === 'still_running' ? 'reconcile_required' : 'reconciled';
    run('UPDATE claims SET state=?, reconcile_by=?, reconcile_outcome=?, reconcile_evidence=?, released_at=? WHERE resource=? AND fence=?', state, as, outcome, evidence, now(), resource, f);
    bumpRoots(claimRoots(resource, c.env));
    return { resource, fence: f, state, outcome };
  });
}

export function claims({ owner, state } = {}) {
  return { claims: all('SELECT * FROM claims WHERE (? IS NULL OR owner=?) AND (? IS NULL OR state=?) ORDER BY resource', owner ?? null, owner ?? null, state ?? null, state ?? null) };
}

// ---------- dependency readiness ----------

export function depAdd(work, needKind, ref) {
  if (!DEP_NEEDS.includes(needKind)) throw refuse('invalid', `need must be one of ${DEP_NEEDS.join('|')}`);
  need(work, 'work'); need(ref, 'ref');
  if (needKind === 'claim_free') ref = canonicalResource(ref);
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

const LOCAL_NEEDS = ['event_acked', 'claim_free', 'release_done'];
// Dependencies backed by coord's own tables; re-evaluated inside the final ready() transaction.
function localDep(d) {
  if (d.need === 'event_acked') {
    const e = get('SELECT seq FROM events WHERE event_key=?', d.ref);
    const open = e && get("SELECT COUNT(*) n FROM deliveries WHERE event_seq=? AND status!='acked'", e.seq).n;
    return !e ? { state: 'waiting', why: 'event not posted' } : open ? { state: 'waiting', why: `${open} recipients unacked` } : { state: 'ready', why: 'all acked', evidence: `seq ${e.seq}` };
  }
  if (d.need === 'claim_free') {
    const c = get("SELECT * FROM claims WHERE resource=? AND state IN ('active','reconcile_required')", d.ref);
    return c ? { state: 'waiting', why: `${c.state} by ${c.owner}` } : { state: 'ready', why: 'no claim' };
  }
  const x = get('SELECT * FROM releases WHERE request_key=? OR CAST(id AS TEXT)=?', d.ref, d.ref);
  return x?.state === 'done' ? { state: 'ready', why: 'release done', evidence: x.readback } : { state: 'waiting', why: `release ${x?.state ?? 'not requested'}` };
}

// External needs (pr_merged, pr_deployed) are evaluated by `external(dep)` when supplied (see evidence.mjs).
export async function ready(work, { external = evidence.external } = {}) {
  const out = [];
  const versions = new Map();
  for (const d of all('SELECT * FROM deps WHERE work_id=? ORDER BY id', work)) {
    versions.set(d.id, d.version);
    let r = { state: d.state, why: d.why, evidence: d.evidence };
    if (d.state !== 'dead' && !(d.state === 'ready' && ['manual', 'ticket_done'].includes(d.need))) {
      if (LOCAL_NEEDS.includes(d.need)) {
        r = localDep(d);
      } else if (['pr_merged', 'pr_deployed'].includes(d.need) && external) {
        r = await external(d).catch(e => ({ state: 'waiting', why: `check failed: ${e.message}` }));
      } else if (d.state !== 'ready') {
        r = { state: 'waiting', why: d.need === 'manual' || d.need === 'ticket_done' ? 'set by hand with dep set' : 'no evaluator' };
      }
      // Compare-and-set: a decision made while the check was pending (dep set dead/ready) wins.
      const u = run('UPDATE deps SET state=?, why=?, evidence=?, checked_at=?, version=version+1 WHERE id=? AND version=?',
        r.state, r.why ?? null, r.evidence ?? null, now(), d.id, d.version);
      if (Number(u.changes)) versions.set(d.id, d.version + 1);
      else {
        const cur = get('SELECT * FROM deps WHERE id=?', d.id);
        r = { state: cur.state, why: cur.why, evidence: cur.evidence, changed: true };
        versions.set(d.id, cur.version);
      }
    }
    out.push({ id: d.id, need: d.need, ref: d.ref, ...r });
  }
  // Readiness holds only if the dependency set and every row are exactly what this pass saw and wrote.
  return tx(() => {
    const final = all('SELECT id, need, ref, state, why, evidence, version FROM deps WHERE work_id=? ORDER BY id', work);
    const changed = final.length !== versions.size || final.some(f => versions.get(f.id) !== f.version);
    if (changed) return { work, ready: false, changed: true, why: 'dependencies changed during the check; run ready again', deps: final };
    const moved = final.filter(d => d.state !== 'dead' && LOCAL_NEEDS.includes(d.need)).find(d => localDep(d).state !== d.state);
    if (moved) return { work, ready: false, changed: true, why: `${moved.need} ${moved.ref} changed during the check; run ready again`, deps: final };
    return { work, ready: final.length > 0 && final.every(d => d.state === 'ready'), deps: out };
  });
}

// ---------- release / TF / DDL / QA admission ----------

const SHA = /^[0-9a-f]{40}$/;
const relRow = id => {
  const r = get('SELECT * FROM releases WHERE id=?', Number(id));
  if (!r) throw refuse('not_found', `no release ${id}`);
  return { ...r, footprint: parse(r.footprint), content_prs: parse(r.content_prs), readback: parse(r.readback), claim_fences: parse(r.claim_fences) };
};
const touch = (id, set) => {
  const keys = Object.keys(set);
  run(`UPDATE releases SET ${keys.map(k => `${k}=?`).join(', ')}, version=version+1, updated_at=? WHERE id=?`, ...keys.map(k => set[k]), now(), id);
};
const overlap = (a, b) => a.some(x => b.includes(x));
// Two mutations conflict on any shared non-env resource, or on the environment when either is env-exclusive.
// Plain deploys share env:<env> only for claim and QA checks; GitHub's crpko-dev-mutation group serializes their runs.
const conflicts = (a, b) => overlap(a.footprint.filter(f => !f.startsWith('env:')), b.footprint.filter(f => !f.startsWith('env:')))
  || ((a.env_exclusive || b.env_exclusive) && a.environment === b.environment);
const fingerprint = o => hash(o);
// Release binaries and environments: crpko-devops plan/schemas/cicd/release-tag.schema.json
// (properties.binary.enum / env.enum) at main-dev 34264683c2, as read by scripts/validate-release-tag.mjs.
// Repository names are not binaries: custody-transfer releases `custody-transfers`, market-data-mock
// `market-data`, venue-router-adapters-mock `venue-router-adapters`, risk-liquidation-latest `risk-liquidation`.
export const RELEASE_BINARIES = ['backoffice-core', 'backoffice-frontend', 'clickhouse-ingestor', 'compliance-kyc', 'crypko-frontend',
  'custody-transfers', 'edge-api', 'market-data', 'registry', 'reporting', 'rewards', 'risk-liquidation', 'trading-core',
  'venue-router-adapters', 'ws-gateway'];
const RELEASE_ENVS = ['dev', 'staging', 'prod'];
// Release tags as scripts/validate-release-tag.mjs parses them: exactly one allowed binary must match
// ^<binary>-docs<N>-<env>.<M>$ with N, M >= 1 and no leading zeros.
export function parseTag(tag) {
  const hits = RELEASE_BINARIES.flatMap(binary => {
    const m = new RegExp(`^${binary}-docs([1-9][0-9]*)-(${RELEASE_ENVS.join('|')})\\.([1-9][0-9]*)$`).exec(String(tag ?? ''));
    return m ? [{ binary, docs: Number(m[1]), env: m[2], version: Number(m[3]) }] : [];
  });
  return hits.length === 1 ? hits[0] : null;
}
function tagError(tag, binary, env) {
  const t = parseTag(tag);
  if (!t) return refuse('invalid_tag', `${tag} is not <binary>-docs<N>-<env>.<M> for a release binary (${RELEASE_BINARIES.join(', ')})`);
  if (t.binary !== binary || t.env !== env) return refuse('invalid_tag', `${tag} is ${t.binary}/${t.env}, request is ${binary}/${env}`);
  return null;
}
export const canonRepo = r => String(r ?? '').trim().toLowerCase();
export const canonBinary = b => String(b ?? '').trim().toLowerCase();

// Terraform roots a service deploy applies, from deploy-dev-service.yml (crpko-devops main-dev 34264683c2):
// registry plans and applies terraform/roots/dev ("Deploy registry publisher"); risk-liquidation hands state
// from dev to (and may bootstrap-apply) dev-risk-liquidation, and reconciles dev-core-capacity.
export const SERVICE_TF_ROOTS = {
  registry: ['dev'],
  // The state handoff moves resources out of terraform/roots/dev and pushes that source state back.
  'risk-liquidation': ['dev', 'dev-risk-liquidation', 'dev-core-capacity'],
};
// Saved plans are always the full `dev` root (terraform-dev.yml terraform-saved-plan-apply job).
export const SAVED_PLAN_ROOT = 'dev';

// Locks every operation takes whatever footprint the caller sends; the caller's footprint only adds to them.
function intrinsic(row) {
  const out = [`env:${row.environment}`];
  if (row.repo) out.push(`repo:${row.repo}`);
  if (row.binary) out.push(`svc:${row.binary}`);
  for (const root of row.kind === 'tf_apply' ? [row.tf_root] : SERVICE_TF_ROOTS[row.binary] ?? []) out.push(`tf:${root}`);
  return out;
}
const tfRoots = r => r.footprint.filter(f => f.startsWith('tf:')).map(f => f.slice(3));

// Hooks supplied by the embedding process (crw); see README "Contracts".
export const hooks = { gateCheck: null, rangeResolver: null, runtime: null, planRun: null };
export function configure(o = {}) {
  for (const k of Object.keys(hooks)) if (k in o) hooks[k] = o[k];
  return Object.fromEntries(Object.keys(hooks).map(k => [k, !!hooks[k]]));
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

// Content-range check, run at admission and at start: the runtime the request was based on is still what
// is live, the resolver's PR list for runtimeSha..sha equals the request's, and every PR clears its gates.
async function rangeChecks(r, o = {}) {
  if (!DEPLOY_KINDS.includes(r.kind)) return { ok: true };
  const runtime = o.runtime ?? hooks.runtime ?? defaultRuntime;
  const resolver = o.rangeResolver ?? hooks.rangeResolver;
  const gateCheck = o.gateCheck ?? hooks.gateCheck;
  if (typeof resolver !== 'function') return { ok: false, code: 'range_unavailable', reason: 'no rangeResolver hook configured' };
  let rt, range;
  try { rt = await runtime(r); } catch (e) { return { ok: false, code: 'runtime_unknown', reason: e.message }; }
  if (rt?.state !== 'known') return { ok: false, code: 'runtime_unknown', reason: rt?.reason ?? 'runtime not known' };
  if (rt.sha !== r.runtime_sha) return { ok: false, code: 'runtime_moved', reason: `live is ${rt.sha} (run ${rt.run}), request was based on ${r.runtime_sha}` };
  try { range = await resolver({ repo: r.repo, binary: r.binary, environment: r.environment, base: r.runtime_sha, head: r.git_sha }); }
  catch (e) { return { ok: false, code: 'range_unavailable', reason: e.message }; }
  if (!range || range.complete !== true || !Array.isArray(range.prs)) return { ok: false, code: 'range_unavailable', reason: 'resolver did not return a complete range' };
  if (!sameSet(range.prs, r.content_prs)) return { ok: false, code: 'range_mismatch', reason: `range ${r.runtime_sha.slice(0, 12)}..${r.git_sha.slice(0, 12)} is [${range.prs.join(', ')}], request lists [${r.content_prs.join(', ')}]` };
  const evidenceOut = { runtime: { run: rt.run, attempt: rt.attempt, sha: rt.sha }, range: range.evidence ?? null, prs: [] };
  if (!range.prs.length) return { ok: true, evidence: evidenceOut };
  if (typeof gateCheck !== 'function') return { ok: false, code: 'gate_unavailable', reason: 'no gateCheck hook configured' };
  let res;
  try { res = await gateCheck(r); } catch (e) { return { ok: false, code: 'gate_unavailable', reason: e.message }; }
  const got = new Map((res?.prs ?? []).map(p => [p.pr, p]));
  const missing = r.content_prs.filter(pr => !(got.get(pr)?.ok === true && got.get(pr)?.evidence));
  if (missing.length) return { ok: false, code: 'gates_not_clear', reason: `no positive gate evidence for ${missing.join(', ')}`, missing };
  evidenceOut.prs = r.content_prs.map(pr => ({ pr, evidence: got.get(pr).evidence }));
  return { ok: true, evidence: evidenceOut };
}
const defaultRuntime = r => r.kind === 'frontend_release'
  ? evidence.frontendRuntime({ repo: r.repo, env: r.environment }) : evidence.serviceRuntime({ binary: r.binary, env: r.environment });

export function tfRootGen(root) {
  root = canonicalResource(`tf:${need(root, 'root')}`).slice(3);
  const t = get('SELECT gen, bumped_at FROM tf_roots WHERE root=?', root);
  return { root, gen: t?.gen ?? 0, bumped_at: t?.bumped_at ?? null };
}
// Terraform roots a mutation claim may touch: tf:<root> itself; env:<e> every known root of <e>.
// Known roots are the saved-plan root, the service release roots and any root already recorded.
function claimRoots(resource, scope) {
  if (resource.startsWith('tf:')) return [resource.slice(3)];
  if (!resource.startsWith('env:') || !scope) return [];
  const known = [SAVED_PLAN_ROOT, ...Object.values(SERVICE_TF_ROOTS).flat(), ...all('SELECT root FROM tf_roots').map(x => x.root)];
  return [...new Set(known)].filter(root => intrinsicEnv(`tf:${root}`) === scope);
}
const bumpRoots = roots => {
  for (const root of roots) run('INSERT INTO tf_roots (root,gen,bumped_at) VALUES (?,1,?) ON CONFLICT(root) DO UPDATE SET gen=gen+1, bumped_at=excluded.bumped_at', root, now());
};

export function releaseRequest(o = {}) {
  const { as, key, kind } = o;
  need(as, 'as'); need(key, 'key');
  if (!RELEASE_KINDS.includes(kind) || kind === 'qa_window') throw refuse('invalid', `kind must be one of ${RELEASE_KINDS.filter(k => k !== 'qa_window').join('|')}`);
  const env = canonicalEnv(o.env); // dev only: nothing could ever observe another env to a terminal state
  const repo = o.repo ? canonRepo(o.repo) : null, binary = o.binary ? canonBinary(o.binary) : null;
  let contentPrs = null, tfRoot = null;
  if (DEPLOY_KINDS.includes(kind)) {
    need(repo, 'repo'); need(binary, 'binary');
    if (!SHA.test(o.sha ?? '')) throw refuse('invalid', 'sha must be a full 40-char revision');
    if (!SHA.test(o.runtimeSha ?? '')) throw refuse('invalid', 'runtimeSha (what is live now) must be a full 40-char revision');
    contentPrs = Array.isArray(o.contentPrs) ? o.contentPrs : list(o.contentPrs, null);
    if (!contentPrs) throw refuse('invalid', 'contentPrs (every PR in runtimeSha..sha, possibly empty) is required');
    contentPrs = [...new Set(contentPrs)].sort();
  }
  if (kind === 'service_release' && !o.tag) throw refuse('invalid', 'tag (the release tag that will be cut) is required');
  if (['service_release', 'redispatch'].includes(kind) && o.tag) { const e = tagError(o.tag, binary, env); if (e) throw e; }
  if (kind === 'redispatch' && !(o.tag && o.digest)) throw refuse('invalid', 'redispatch binds the existing tag and digest');
  if (kind === 'tf_apply') {
    if (!/^saved:\d+@\d+$/.test(o.plan ?? '')) throw refuse('invalid', 'tf_apply plan must be saved:<plan run id>@<attempt>');
    if ((o.tfRoot && canonicalResource(`tf:${o.tfRoot}`).slice(3) !== SAVED_PLAN_ROOT) || (o.targets && list(o.targets, []).length) || o.fullRoot === false)
      throw refuse('invalid', `a saved plan is always the full ${SAVED_PLAN_ROOT} root; tfRoot/targets contradict it`);
    tfRoot = SAVED_PLAN_ROOT;
  }
  if (['ddl', 'migration'].includes(kind) && !/^[\w.-]+\.sql@[0-9a-f]{64}$/.test(o.plan ?? ''))
    throw refuse('invalid', `${kind} plan must be <file>.sql@<sha256 of the SQL>`);
  const row = {
    requester: as, kind, environment: env, repo, binary, git_sha: o.sha ?? null,
    runtime_sha: o.runtimeSha ?? null, content_prs: json(contentPrs), tag: o.tag ?? null,
    image_digest: o.digest ?? null, plan_id: o.plan ?? null, risk: o.risk ?? 'ordinary', batch_id: o.batch ?? null, tf_root: tfRoot,
  };
  const extra = canonList(Array.isArray(o.footprint) ? o.footprint : list(o.footprint, []));
  row.footprint = json(canonList([...intrinsic(row), ...extra]).sort());
  row.env_exclusive = MANUAL_KINDS.includes(kind) || extra.includes(`env:${env}`) ? 1 : 0;
  if (!['ordinary', 'stateful', 'high'].includes(row.risk)) throw refuse('invalid', 'risk must be ordinary|stateful|high');
  const fp = fingerprint(row);
  return tx(() => {
    const prev = get('SELECT id, fingerprint FROM releases WHERE request_key=?', key);
    if (prev) {
      if (prev.fingerprint !== fp) throw refuse('conflict', `release request ${key} exists with a different binding`, { status: 409, id: prev.id });
      return { release: relRow(prev.id), duplicate: true };
    }
    if (row.plan_id && get("SELECT id FROM releases WHERE plan_id=? AND kind=?", row.plan_id, kind))
      throw refuse('conflict', `plan ${row.plan_id} was already registered`);
    const t = now();
    const cols = Object.keys(row);
    const id = Number(run(`INSERT INTO releases (request_key,fingerprint,${cols.join(',')},state,created_at,updated_at) VALUES (?,?,${cols.map(() => '?').join(',')},'requested',?,?)`,
      key, fp, ...cols.map(k => row[k]), t, t).lastInsertRowid);
    return { release: relRow(id) };
  });
}

// Claims on the operation's resources. Expired leases become reconcile_required and block everyone;
// claims of `owners` are allowed and their exact fences returned, so start can require the same ones.
function claimsFor(footprint, owners) {
  const relied = {};
  for (const resource of footprint) {
    const c = expire(get('SELECT * FROM claims WHERE resource=?', resource));
    if (c?.state === 'reconcile_required') return refuse('reconcile_required', `${resource} needs reconcile (${c.owner}, op ${c.op_ref ?? '-'})`, { owner: c.owner, op_ref: c.op_ref });
    if (c?.state !== 'active') continue;
    if (!owners.includes(c.owner)) return refuse('claimed', `${resource} is held by ${c.owner}`, { owner: c.owner, fence: c.fence });
    relied[resource] = { owner: c.owner, fence: c.fence };
  }
  return relied;
}
// Resources whose claims a release must respect: its footprint, plus, when env-exclusive, every
// mutation claim in its environment (whatever the resource).
function claimResources(r) {
  if (!r.env_exclusive) return r.footprint;
  const scoped = all("SELECT resource, env FROM claims WHERE state IN ('active','reconcile_required') AND env IS NOT NULL")
    .filter(c => envMatch(c.env, r.environment)).map(c => c.resource);
  return [...new Set([...r.footprint, ...scoped])];
}
// The claims relied on at admission must still be the same active fences at start; no new foreign claim.
function sameClaims(r) {
  const now_ = claimsFor(claimResources(r), [r.admitted_by, r.requester]);
  if (now_ instanceof Error) return now_;
  const before = r.claim_fences ?? {};
  for (const res of new Set([...Object.keys(before), ...Object.keys(now_)])) {
    const a = before[res], b = now_[res];
    if (!a || !b || a.owner !== b.owner || a.fence !== b.fence)
      return refuse('stale_fence', `claim on ${res} changed since admission (${a ? `${a.owner}#${a.fence}` : 'none'} -> ${b ? `${b.owner}#${b.fence}` : 'none'})`);
  }
  return null;
}
// Any open QA window holds its whole environment, expired or not, until master/release closes it.
const openQa = env => get("SELECT id, requester FROM releases WHERE kind='qa_window' AND state='running' AND environment=?", env);

function builtBlockers(r) {
  if (!r.repo) return [];
  return all("SELECT * FROM releases WHERE state='built_not_deployed' AND repo=? AND environment=? AND id!=?", r.repo, r.environment, r.id);
}
// Built releases of the repo block everything but the one redispatch admitted for its exact source row.
function builtCheck(r) {
  const built = builtBlockers(r);
  if (r.kind === 'redispatch') {
    const src = r.redispatch_of ? built.find(b => b.id === r.redispatch_of)
      : built.find(b => b.binary === r.binary && b.tag === r.tag && b.image_digest === r.image_digest && b.git_sha === r.git_sha);
    if (!src) return refuse('no_built_release', `no built_not_deployed ${r.binary} release in ${r.environment} with tag ${r.tag} and digest ${r.image_digest}`);
    const other = built.find(b => b.id !== src.id);
    if (other) return refuse('built_not_deployed', `release #${other.id} (${other.binary} ${other.tag}) is also built but not deployed`, { blocking: other.id });
    return src;
  }
  if (built.length) return refuse('built_not_deployed', `release #${built[0].id} (${built[0].binary} ${built[0].tag}) is built but not deployed; redispatch or reconcile it first`, { blocking: built[0].id });
  return null;
}

// Saved plans are stale once any mutation of their root started or ended after the plan run attempt began.
function tfCheck(r, { at }) {
  if (r.kind !== 'tf_apply') return null;
  if (flag('tf_full_root_blocked')) return refuse('tf_full_root_blocked', 'a saved plan is a full-root apply; blocked until master clears tf_full_root_blocked');
  const last = tfRootGen(r.tf_root);
  if (last.bumped_at !== null && r.planned_at !== null && r.planned_at <= last.bumped_at) {
    touch(r.id, { state: 'superseded', failure: `plan run started before the last ${r.tf_root} mutation (${at})` });
    return refuse('stale_plan', `plan ${r.plan_id} started before the last mutation of ${r.tf_root} (gen ${last.gen})`);
  }
  return null;
}

// The planRun hook must positively verify the saved plan: a finite positive startedAt, and when it
// reports run/attempt they must be the pinned ones. Anything else (null, malformed, a throw) is plan_unverified.
async function verifiedPlan(planId, o) {
  let p;
  try { p = await (o.planRun ?? hooks.planRun ?? evidence.planRun)(planId); } catch (e) { throw refuse(e.code ?? 'plan_unverified', e.message); }
  const [, run_, attempt] = /^saved:(\d+)@(\d+)$/.exec(planId);
  if (!p || typeof p !== 'object' || !Number.isFinite(p.startedAt) || p.startedAt <= 0)
    throw refuse('plan_unverified', `plan ${planId}: verification returned no positive start time`);
  if ((p.run !== undefined && String(p.run) !== run_) || (p.attempt !== undefined && Number(p.attempt) !== Number(attempt)))
    throw refuse('plan_unverified', `plan ${planId}: verification is for run ${p.run} attempt ${p.attempt}`);
  return p;
}

// verify(release) revalidates the pinned head; planRun(planId) resolves the saved plan's run attempt.
export async function releaseAdmit(id, o = {}) {
  const { as, manual = false } = o;
  need(as, 'as');
  const r0 = relRow(id);
  if (r0.state === 'admitted' && r0.admitted_by === as) return { release: r0, duplicate: true };
  if (r0.state !== 'requested') throw refuse('bad_state', `release ${id} is ${r0.state}`);
  if (MANUAL_KINDS.includes(r0.kind) && !(manual && DEFAULTS.admitters.includes(as)))
    throw refuse('manual_admit_required', `${r0.kind} needs a manual admit by ${DEFAULTS.admitters.join('|')}`);
  const v = r0.git_sha ? await (o.verify ?? evidence.verifyHead)(r0) : { ok: true };
  const g = await rangeChecks(r0, o);
  let plan = null;
  if (r0.kind === 'tf_apply') {
    plan = await verifiedPlan(r0.plan_id, o);
  }
  return tx(() => {
    let r = relRow(id);
    if (r.version !== r0.version) throw refuse('changed', `release ${id} changed during admission; retry`);
    requireMode(`env:${r.environment}`);
    if (v.transient) throw refuse('verify_failed', `could not revalidate ${r.git_sha}: ${v.reason}`);
    if (!v.ok) {
      touch(r.id, { state: 'superseded', failure: `stale revision: ${v.reason ?? 'head check failed'}` });
      return refuse('stale_revision', `release ${id} ${r.git_sha} no longer valid: ${v.reason ?? ''}`.trim());
    }
    if (!g.ok) throw refuse(g.code, g.reason, { missing: g.missing });
    if (r.tag) { const e = tagError(r.tag, r.binary, r.environment); if (e) throw e; }
    if (plan) { touch(r.id, { planned_at: plan.startedAt }); r = relRow(id); }
    if (r.kind === 'tf_apply' && !(r.planned_at > 0)) throw refuse('plan_unverified', `plan ${r.plan_id} has no verified start time`);
    const tf = tfCheck(r, { at: 'admit' });
    if (tf) return tf;
    const qa = openQa(r.environment);
    if (qa) throw refuse('qa_window_open', `QA window #${qa.id} (${qa.requester}) holds ${r.environment}`, { blocking: qa.id });
    const busy = all("SELECT id, kind, environment, env_exclusive, footprint FROM releases WHERE id!=? AND state IN ('admitted','running') AND kind!='qa_window'", r.id)
      .find(x => conflicts({ ...x, footprint: parse(x.footprint) }, r));
    if (busy) throw refuse('footprint_busy', `overlaps ${busy.kind} #${busy.id}`, { blocking: busy.id });
    const relied = claimsFor(claimResources(r), [as, r.requester]);
    if (relied instanceof Error) return relied;
    const src = builtCheck(r);
    if (src instanceof Error) throw src;
    const needsManual = r.risk !== 'ordinary' || MANUAL_KINDS.includes(r.kind) || r.kind === 'redispatch' || r.footprint.filter(f => f.startsWith('svc:')).length > 1;
    if (needsManual && !(manual && DEFAULTS.admitters.includes(as)))
      throw refuse('manual_admit_required', `${r.kind}/${r.risk} needs a manual admit by ${DEFAULTS.admitters.join('|')}`);
    run('INSERT INTO fences (resource,fence) VALUES (?,1) ON CONFLICT(resource) DO UPDATE SET fence=fence+1', `release:${r.environment}`);
    const fence = get('SELECT fence FROM fences WHERE resource=?', `release:${r.environment}`).fence;
    touch(r.id, { state: 'admitted', admitted_by: as, admitted_at: now(), fence, claim_fences: json(relied),
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
  const g = await rangeChecks(r0, o);
  let plan = null;
  if (r0.kind === 'tf_apply') {
    plan = await verifiedPlan(r0.plan_id, o);
  }
  return tx(() => {
    const r = relRow(id);
    if (r.version !== r0.version) throw refuse('changed', `release ${id} changed during start checks; retry`);
    if (r.kind === 'tf_apply' && !(r.planned_at > 0 && plan.startedAt === r.planned_at))
      throw refuse('plan_unverified', `plan ${r.plan_id} start ${plan.startedAt} does not match the admitted ${r.planned_at}`);
    if (r.tag) { const e = tagError(r.tag, r.binary, r.environment); if (e) throw e; }
    requireMode(`env:${r.environment}`, true);
    if (r.fence !== Number(fence)) throw refuse('stale_fence', `fence ${fence} is not the admission fence`);
    if (as !== r.requester && as !== r.admitted_by) throw refuse('forbidden', `${as} did not request or admit release ${id}`);
    // Restated bindings are compared in canonical form, the same form the request stored.
    const lower = v => String(v).toLowerCase();
    const canonOf = { repo: canonRepo, env: e => canonicalEnv(e, { supported: false }), sha: lower };
    for (const [k, col] of [['sha', 'git_sha'], ['repo', 'repo'], ['env', 'environment'], ['plan', 'plan_id'], ['tag', 'tag'], ['digest', 'image_digest']]) {
      const want = o[k] !== undefined && canonOf[k] ? canonOf[k](o[k]) : o[k];
      if (o[k] !== undefined && (r[col] !== null || ['sha', 'repo', 'env', 'plan', 'tag'].includes(k)) && want !== r[col])
        throw refuse('binding_mismatch', `${k} ${o[k]} differs from admitted ${r[col]}`);
    }
    if (v.transient) throw refuse('verify_failed', `could not revalidate ${r.git_sha}: ${v.reason}`);
    if (!v.ok) {
      touch(r.id, { state: 'superseded', failure: `head moved after admission: ${v.reason ?? ''}` });
      return refuse('head_moved', `release ${id} head moved after admission: ${v.reason ?? ''}`.trim());
    }
    if (!g.ok) throw refuse(g.code, g.reason, { missing: g.missing });
    const tf = tfCheck(r, { at: 'start' });
    if (tf) return tf;
    const qa = openQa(r.environment);
    if (qa) throw refuse('qa_window_open', `QA window #${qa.id} holds ${r.environment}`, { blocking: qa.id });
    const moved = sameClaims(r);
    if (moved) return moved;
    const src = builtCheck(r);
    if (src instanceof Error) throw src;
    const set = { state: 'running', gate_evidence: json(g.evidence), ...bindOnce(r, o, ['digest', 'releaseRun', 'deployRun', 'tfRun']) };
    touch(r.id, set);
    // Any started mutation that touches a Terraform root invalidates plans made against that root.
    bumpRoots(tfRoots(r));
    if (r.kind === 'redispatch') touch(src.id, { state: 'superseded', outcome: `redispatched as #${r.id}` });
    return { release: relRow(r.id) };
  });
}

const RUN_FIELDS = { tag: 'tag', digest: 'image_digest', releaseRun: 'release_run', deployRun: 'deploy_run', tfRun: 'tf_run' };
// Bind-once: a field may be set when unbound or to the value it already has; returns the columns to write.
function bindOnce(r, o, keys) {
  const set = {};
  for (const k of keys) {
    if (o[k] === undefined || o[k] === null) continue;
    const col = RUN_FIELDS[k];
    if (r[col] !== null && r[col] !== undefined && String(r[col]) !== String(o[k])) throw refuse('binding_mismatch', `${col} already ${r[col]}, not ${o[k]}`);
    if (k === 'digest' && !/^sha256:[0-9a-f]{64}$/.test(o[k])) throw refuse('invalid', 'digest must be sha256:<64 hex>');
    if (k === 'tag') { const e = tagError(o[k], r.binary, r.environment); if (e) throw e; }
    if (r[col] === null || r[col] === undefined) set[col] = String(o[k]);
  }
  return set;
}
const BUILT_FIELDS = { tag: 'tag', digest: 'image_digest', deployRun: 'deploy_run' };
// Records run ids or a digest found after dispatch. On a built_not_deployed row an admitter may bind the
// tag, digest or downstream run from evidence (so it can be redispatched); the row stays built_not_deployed.
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
    for (const k of Object.keys(RUN_FIELDS))
      if (o[k] !== undefined && (built ? !(k in BUILT_FIELDS) : k === 'tag')) throw refuse('invalid', `${k} cannot be recorded on a ${r.state} release`);
    const set = bindOnce(r, o, Object.keys(RUN_FIELDS));
    if (built && Object.keys(set).length) set.outcome = `recorded by ${o.as}: ${o.evidence}`;
    if (Object.keys(set).length) touch(r.id, set);
    return { release: relRow(r.id) };
  });
}

const RECONCILE = {
  // outcome -> [states it applies to, resulting state]
  not_started: [['admitted', 'running'], 'cancelled'],
  still_running: [['admitted', 'running'], null],
  done: [['running'], 'done'],
  rolled_back: [['running'], 'failed'],
  failed: [['running'], 'failed'],
  built: [['running'], 'built_not_deployed'],
};
// Closes a release whose outcome automation cannot establish: Terraform/DDL/migration always, and
// deploys that crashed before dispatch or whose evidence stays unknown. Exclusion holds until called.
// A Terraform `done` is checked against the saved plan's run: if a newer attempt exists, the apply may have
// consumed it instead, so `done` needs evidence that names the plan attempt the apply used (`plan attempt <n>`).
export async function releaseReconcile(id, { as, outcome, evidence: ev, currentAttempt = evidence.currentAttempt } = {}) {
  need(as, 'as'); need(ev, 'evidence');
  if (!DEFAULTS.reconcilers.includes(as)) throw refuse('forbidden', `${as} may not reconcile releases (allowed: ${DEFAULTS.reconcilers.join(',')})`);
  const rule = RECONCILE[outcome];
  if (!rule) throw refuse('invalid', `outcome must be ${Object.keys(RECONCILE).join('|')}`);
  const r0 = relRow(id);
  if (r0.kind === 'tf_apply' && outcome === 'done') {
    const [, run_, pinned] = /^saved:(\d+)@(\d+)$/.exec(r0.plan_id);
    let latest;
    try { latest = await currentAttempt(run_); } catch (e) { throw refuse('plan_unverified', `cannot read plan run ${run_}: ${e.message}`); }
    const named = Number(/\bplan attempt\s+(\d+)\b/i.exec(ev)?.[1]);
    if (latest !== Number(pinned) && !(named >= Number(pinned) && named <= latest))
      throw refuse('plan_attempt_moved', `plan run ${run_} is at attempt ${latest}, admitted ${pinned}; name the plan attempt the apply used ("plan attempt <n>") in the evidence`);
  }
  return tx(() => {
    const r = relRow(id);
    if (r.version !== r0.version) throw refuse('changed', `release ${id} changed during reconcile; retry`);
    if (r.kind === 'qa_window') throw refuse('invalid', 'close QA windows with qa close');
    if (!rule[0].includes(r.state)) throw refuse('bad_state', `release ${id} is ${r.state}; ${outcome} applies to ${rule[0].join('|')}`);
    if (outcome === 'built' && !['service_release'].includes(r.kind)) throw refuse('invalid', 'only service releases can be built_not_deployed');
    const note = `${outcome} by ${as}: ${ev}`;
    if (!rule[1]) { touch(r.id, { observe_note: `reconciled ${note}` }); return { release: relRow(r.id) }; }
    touch(r.id, { state: rule[1], outcome: note, observed_at: now(), ...(outcome === 'rolled_back' || outcome === 'failed' ? { failure: note } : {}) });
    // A redispatch that provably never ran leaves its built source exactly as it was.
    if (r.kind === 'redispatch' && outcome === 'not_started' && r.state === 'running' && r.redispatch_of) {
      const src = relRow(r.redispatch_of);
      if (src.state === 'superseded' && src.outcome === `redispatched as #${r.id}`) touch(src.id, { state: 'built_not_deployed', outcome: `restored: redispatch #${r.id} not started (${note})` });
    }
    // A Terraform mutation that ended (either way) moved its roots; plans made before now are stale.
    if (r.state === 'running') bumpRoots(tfRoots(r));
    return { release: relRow(r.id) };
  });
}

// `observe(release)` resolves {state, readback?, failure?, outcome?, digest?}; see evidence.observeRelease.
// The result is applied only if the row did not change while the observer ran.
export async function releaseObserve(id, { observe = evidence.observeRelease } = {}) {
  const r = relRow(id);
  if (r.state !== 'running') return { release: r, unchanged: true };
  if (MANUAL_KINDS.includes(r.kind)) return { release: r, pending: `${r.kind} is closed with release reconcile` };
  // A failed observation is an unknown result, applied through the same snapshot check and version bump.
  let o;
  try { o = await observe(r); } catch (e) { o = { state: 'unknown', why: `observation failed: ${e.code ?? 'error'}: ${e.message}`.slice(0, 500) }; }
  return tx(() => {
    const cur = relRow(id);
    if (cur.version !== r.version) return { release: cur, pending: 'release changed while observing; observe again' };
    // Persist the run attempts and downstream run the observer saw, pending or terminal. A value that
    // differs from one already bound is an unaccounted run: the result becomes unknown.
    const set = {};
    let conflict = null;
    for (const [col, v] of Object.entries(o?.bind ?? {})) {
      if (v === undefined || v === null) continue;
      if (cur[col] !== null && cur[col] !== undefined && String(cur[col]) !== String(v)) conflict = `${col} is ${cur[col]}, observed ${v}`;
      else if (cur[col] === null || cur[col] === undefined) set[col] = col === 'deploy_run' ? String(v) : Number(v);
    }
    const terminal = o && ['done', 'failed', 'built_not_deployed'].includes(o.state) && !conflict;
    if (!terminal) {
      const note = conflict ? `unknown: ${conflict}; reconcile manually` : `${o?.state ?? 'unknown'}: ${o?.why ?? 'no result'}`;
      // Bumps the version even without new bindings, so an older observation still in flight is dropped.
      // updated_at stays: it ages a dispatch whose downstream run has not been found.
      const cols = { ...set, observed_at: now(), observe_note: note };
      run(`UPDATE releases SET ${Object.keys(cols).map(k => `${k}=?`).join(', ')}, version=version+1 WHERE id=?`, ...Object.values(cols), r.id);
      return { release: relRow(id), pending: note };
    }
    if (o.digest && cur.image_digest && o.digest !== cur.image_digest)
      throw refuse('binding_mismatch', `observed digest ${o.digest} differs from bound ${cur.image_digest}`);
    touch(r.id, { ...set, state: o.state, readback: json(o.readback), failure: o.failure ?? null, outcome: o.outcome ?? o.state, observed_at: now(),
      ...(o.digest && !cur.image_digest ? { image_digest: o.digest } : {}) });
    bumpRoots(tfRoots(r));
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
  if (env !== undefined && env !== null) env = canonicalEnv(env, { supported: false });
  return { releases: all('SELECT id FROM releases WHERE (? IS NULL OR state=?) AND (? IS NULL OR environment=?) ORDER BY id', state ?? null, state ?? null, env ?? null, env ?? null).map(x => relRow(x.id)) };
}

// A QA window is a release row of kind qa_window that goes straight to running. It holds its whole
// environment against every mutation (and every mutation holds it off), whatever the footprint strings.
// Expiry only raises attention; it never frees the environment on its own.
export function qaOpen({ as, env, footprint, ttl, key } = {}) {
  need(as, 'as');
  env = canonicalEnv(env);
  const fp = canonList([...(Array.isArray(footprint) ? footprint : list(footprint, [])), `env:${env}`]).sort();
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
    // No mutation claim in the environment may coexist with a QA window, whoever holds it.
    const scoped = all("SELECT resource, env FROM claims WHERE state IN ('active','reconcile_required') AND env IS NOT NULL")
      .filter(c => envMatch(c.env, env)).map(c => c.resource);
    const envClaim = claimsFor([...new Set([`env:${env}`, ...scoped])], []);
    if (envClaim instanceof Error) return envClaim;
    const held = claimsFor(fp.filter(f => f !== `env:${env}` && !scoped.includes(f)), [as]);
    if (held instanceof Error) return held;
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

// Read-only check on open: every stored resource key, environment, scope and Terraform root must already
// be canonical. coord never rewrites stored state; a non-canonical row (written by an older version or by
// hand) refuses the open with noncanonical_state, naming the rows, for an operator to reconcile by hand.
// Request fingerprints are derived from these fields, so a canonical row also has a canonical fingerprint.
function checkStoredState() {
  const bad = [];
  const want = (table, id, col, value, canon) => {
    let c;
    try { c = canon(value); } catch (e) { c = `invalid (${e.code})`; }
    if (c !== value) bad.push({ table, id, col, value, canonical: c });
  };
  const res = k => canonicalResource(k);
  const envForm = e => canonicalEnv(e, { supported: false });
  const root = r => canonicalResource(`tf:${r}`).slice(3);
  for (const c of all('SELECT resource, env FROM claims')) {
    want('claims', c.resource, 'resource', c.resource, res);
    if (c.env !== null) want('claims', c.resource, 'env', c.env, envForm);
  }
  for (const f of all('SELECT resource FROM fences')) want('fences', f.resource, 'resource', f.resource, res);
  for (const h of all('SELECT resource, fence FROM claim_history')) want('claim_history', `${h.resource}#${h.fence}`, 'resource', h.resource, res);
  for (const d of all("SELECT id, ref FROM deps WHERE need='claim_free'")) want('deps', d.id, 'ref', d.ref, res);
  for (const r of all('SELECT id, environment, footprint, claim_fences, tf_root, repo, binary FROM releases')) {
    want('releases', r.id, 'environment', r.environment, envForm);
    for (const k of parse(r.footprint) ?? []) want('releases', r.id, 'footprint', k, res);
    for (const k of Object.keys(parse(r.claim_fences) ?? {})) want('releases', r.id, 'claim_fences', k, res);
    if (r.tf_root !== null) want('releases', r.id, 'tf_root', r.tf_root, root);
    if (r.repo !== null) want('releases', r.id, 'repo', r.repo, canonRepo);
    if (r.binary !== null) want('releases', r.id, 'binary', r.binary, canonBinary);
  }
  for (const t of all('SELECT root FROM tf_roots')) want('tf_roots', t.root, 'root', t.root, root);
  for (const c of all("SELECT k FROM control WHERE k LIKE 'mode:%'")) want('control', c.k, 'k', c.k, k => `mode:${canonicalScope(k.slice(5), { supported: false })}`);
  for (const e of all('SELECT seq, environment FROM events WHERE environment IS NOT NULL')) want('events', e.seq, 'environment', e.environment, envForm);
  if (bad.length) {
    const list_ = bad.slice(0, 10).map(b => `${b.table} ${b.id} ${b.col}=${JSON.stringify(b.value)} (canonical: ${b.canonical})`).join('; ');
    throw refuse('noncanonical_state', `stored state is not canonical; reconcile by hand: ${list_}${bad.length > 10 ? `; and ${bad.length - 10} more` : ''}`, { rows: bad });
  }
}
setOnOpen(checkStoredState);

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
// Closes a request whose previous writer finished the work but lost its claim before archDone: the fence it
// was taken under must have been reconciled `done`, and the current arch:broker holder records the commits.
export function archCloseout(id, { as, fence, commits, evidence: ev } = {}) {
  need(ev, 'evidence');
  const list_ = Array.isArray(commits) ? commits : list(commits, []);
  if (!list_.length) throw refuse('invalid', 'commits are required');
  return tx(() => {
    const c = holder(ARCH_RESOURCE, as, fence);
    if (c instanceof Error) return c;
    const a = get('SELECT * FROM arch_requests WHERE id=?', Number(id));
    if (!a) throw refuse('not_found', `no arch request ${id}`);
    if (a.state !== 'taken') throw refuse('bad_state', `arch request ${id} is ${a.state}`);
    const prev = get('SELECT * FROM claim_history WHERE resource=? AND fence=?', ARCH_RESOURCE, a.fence);
    if (!(prev?.state === 'reconciled' && prev.reconcile_outcome === 'done'))
      throw refuse('not_reconciled', `fence ${a.fence} of ${a.taken_by} was not reconciled as done`);
    run("UPDATE arch_requests SET state='done', result_commits=?, result_note=?, updated_at=? WHERE id=?", json(list_),
      `closed by ${as} after ${a.taken_by} fence ${a.fence} reconciled done by ${prev.reconcile_by} (${prev.reconcile_evidence}): ${ev}`, now(), a.id);
    return { request: get('SELECT * FROM arch_requests WHERE id=?', a.id) };
  });
}
export const archList = ({ state } = {}) => ({ requests: all('SELECT * FROM arch_requests WHERE (? IS NULL OR state=?) ORDER BY id', state ?? null, state ?? null) });

// ---------- approval provenance ----------

const RELAY = /^\s*(\[crw\]|\[coord[ \]]|CRPKO_PIPELINE_AUTOMATION:)/;
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
    // messaging=robob: the pump no longer rings, so coord.db's pending deliveries are history, not in-flight work.
    deliveries: messaging().mode === 'robob' ? 0 : get("SELECT COUNT(*) n FROM deliveries WHERE status='pending'").n,
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
  const m = messaging();
  // messaging=robob: unread messages live in Robob (its inbox and doorbell); coord.db deliveries are pre-cutover history.
  if (m.mode === 'robob') return { ...attentionAll(t, unackedAfter), unacked: [], failed_deliveries: [], pending_overdue: [], messaging: { mode: m.mode, mission: m.mission } };
  return attentionAll(t, unackedAfter);
}

function attentionAll(t, unackedAfter) {
  return {
    unacked: all(`SELECT d.event_seq seq, d.recipient, d.status, d.sent_at, d.reminded, e.channel_id, e.summary FROM deliveries d JOIN events e ON e.seq=d.event_seq
      WHERE d.status IN ('sent','skipped') AND COALESCE(d.sent_at, e.created_at)<=?`, t - unackedAfter),
    failed_deliveries: all('SELECT event_seq seq, recipient, attempts, last_error FROM deliveries WHERE status=?', 'failed'),
    reconcile_required: all("SELECT resource, owner, fence, op_ref, reconcile_outcome FROM claims WHERE state='reconcile_required' OR (state='active' AND lease_until<=?)", t),
    releases: all(`SELECT id, kind, environment, repo, binary, tag, state, failure FROM releases
      WHERE state IN ('built_not_deployed','failed') OR (state='superseded' AND outcome IS NULL AND updated_at>?)
        OR (state='requested' AND created_at<=?) OR (state='admitted' AND admitted_at<=?)`, t - 7 * 86400, t - 3600, t - 3600),
    awaiting_reconcile: all("SELECT id, kind, environment, plan_id, tf_run, admitted_by FROM releases WHERE state='running' AND kind IN ('tf_apply','ddl','migration')"),
    unobserved: all("SELECT id, kind, environment, observed_at, observe_note FROM releases WHERE state='running' AND kind!='qa_window' AND observe_note LIKE 'unknown:%'"),
    expired_qa_windows: all("SELECT id, requester, environment, readback FROM releases WHERE kind='qa_window' AND state='running'")
      .filter(q => (parse(q.readback)?.until ?? Infinity) <= t),
    arch_queued: all("SELECT id, kind, requester, summary FROM arch_requests WHERE state='queued'"),
    // Never rung: the pump kept skipping the thread (busy, held queue) or is down.
    pending_overdue: all(`SELECT d.recipient, d.thread_id, COUNT(*) n, MIN(d.event_seq) lo, MAX(d.event_seq) hi, MIN(e.created_at) oldest
      FROM deliveries d JOIN events e ON e.seq=d.event_seq WHERE d.status='pending' AND e.created_at<=? GROUP BY d.recipient, d.thread_id`, t - unackedAfter),
    pump: (r => ({ last_tick: r?.set_at ?? null, stale: !r || r.set_at <= t - 300 }))(get("SELECT set_at FROM control WHERE k='pump:heartbeat'")),
    // Actor threads held 10+ min with queued items the pump must not cancel (owner or agent messages, notices).
    held_queues: parse(get("SELECT v FROM control WHERE k='pump:held_queues'")?.v) ?? [],
  };
}

export function status() {
  const count = (tbl, col) => Object.fromEntries(all(`SELECT ${col} k, COUNT(*) n FROM ${tbl} GROUP BY ${col}`).map(r => [r.k, r.n]));
  return {
    control: all('SELECT * FROM control ORDER BY k'),
    messaging: messaging(),
    actors: all('SELECT * FROM actors ORDER BY id'),
    channels: count('channels', 'status'), deliveries: count('deliveries', 'status'), claims: count('claims', 'state'),
    releases: count('releases', 'state'), arch_requests: count('arch_requests', 'state'), deps: count('deps', 'state'),
  };
}

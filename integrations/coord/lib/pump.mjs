// Delivery pump, doorbell model: per Robob thread at most one outstanding wake that points the agent at
// `coord inbox --unacked`, instead of one queued turn per delivery. A thread is rung only while it is idle
// (or waiting), and not while an earlier wake is still queued unread; deliveries that arrive meanwhile ride
// on that wake. Unacked deliveries get at most one coalesced reminder per thread per `unackedAfter`.
// At-least-once: the clientRequestId is deterministic per (thread, covered deliveries), so a resend after a
// crash between send and mark replays the first result in Robob instead of posting twice.
import { createHash } from 'node:crypto';
import { renameSync, statSync } from 'node:fs';
import { tx, get, all, run } from './db.mjs';
import { clock, gate, DEFAULTS, releaseObserve, messaging } from './coord.mjs';
import { controlConfig } from './control.mjs';

export { controlConfig };

const PREFIX = '/api/ardud/control';
const MAX_ATTEMPTS = 8;
const LEASE = 120;
const MAX_ROWS = 5000;
// Thread states that may be rung, and run statuses that mean an earlier wake has not been read yet.
const RINGABLE = new Set(['idle', 'waiting']);
const UNREAD = new Set(['queued', 'preparing']);
const INLINE = new Set(['control', 'blocker']);
// Self-healing. A queue with nothing running drains within seconds, so a thread still `queued` this long
// after its last run activity has a held queue (Robob holds it after provider failures and restarts) and
// would never be rung. A turn running this long gets a queued wake for deliveries older than unackedAfter.
// A wake whose turn failed is re-rung at most once per relostAfter.
// Every sweepEvery the pump also checks each actor thread: one held staleHeldAfter with only coord wakes queued
// has them cancelled (their unacked deliveries get a fresh wake); one holding other items is listed in attention.
export const HEAL = { heldQueueAfter: 180, longRunAfter: 1800, relostAfter: 300, staleHeldAfter: 600, sweepEvery: 300 };
const sec = iso => (iso ? Math.floor(Date.parse(iso) / 1000) : 0);
const heldQueue = (info, t, after = HEAL.heldQueueAfter) => info?.state === 'queued' &&
  t - Math.max(0, ...(info.recentRuns ?? []).flatMap(r => [sec(r.requestedAt), sec(r.startedAt), sec(r.completedAt)])) >= after;
const longRun = (info, t) => info?.state === 'running' && !!info.run?.startedAt && t - sec(info.run.startedAt) >= HEAL.longRunAfter;

async function call(cfg, method, path, body) {
  const res = await fetch(`${cfg.url}${PREFIX}${path}`, {
    method,
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json', accept: 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.ok === false) {
    const e = new Error(data?.error?.message ?? `HTTP ${res.status}`);
    e.status = res.status;
    e.code = data?.error?.code ?? 'http_error';
    throw e;
  }
  return data;
}

export const sendToThread = (cfg, threadId, text, clientRequestId) =>
  call(cfg, 'POST', `/threads/${encodeURIComponent(threadId)}/send`, { text, mode: 'queue', clientRequestId });
export const threadDetail = async (cfg, threadId) => (await call(cfg, 'GET', `/threads/${encodeURIComponent(threadId)}`)).thread;
export const threadState = async (cfg, threadId) => (await threadDetail(cfg, threadId))?.state;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// The control API has no queue routes (t3_queue_list/t3_queue_cancel are MCP-only), so queued runs are read
// and cancelled over the app's WebSocket RPC with the same token. One request per connection.
async function rpc(cfg, tag, payload) {
  const t = await fetch(`${cfg.url}/api/auth/websocket-ticket`, {
    method: 'POST', headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(30000),
  });
  const ticket = (await t.json().catch(() => null))?.ticket;
  if (!t.ok || !ticket) throw Object.assign(new Error(`websocket ticket: HTTP ${t.status}`), { status: t.status });
  const ws = new WebSocket(`${cfg.url.replace(/^http/, 'ws')}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`);
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${tag}: timeout`)), 30000);
      ws.onopen = () => ws.send(JSON.stringify({ _tag: 'Request', id: '1', tag, payload, headers: [] }));
      ws.onerror = () => reject(new Error(`${tag}: websocket error`));
      ws.onclose = e => reject(new Error(`${tag}: websocket closed (${e.code})`));
      ws.onmessage = e => {
        for (const m of [JSON.parse(e.data)].flat()) {
          if (m._tag === 'Exit' && String(m.requestId) === '1') {
            if (m.exit?._tag === 'Success') resolve(m.exit.value);
            else reject(new Error(`${tag}: ${clip(JSON.stringify(m.exit?.cause ?? m.exit), 300)}`));
          } else if (m._tag === 'Defect' || m._tag === 'ClientProtocolError') reject(new Error(`${tag}: ${clip(JSON.stringify(m), 300)}`));
        }
      };
    });
  } finally {
    clearTimeout(timer);
    ws.close();
  }
}

export const queueApi = {
  async list(cfg, threadId) {
    const p = await rpc(cfg, 'orchestration.getThreadProjection', { threadId });
    const text = new Map((p?.messages ?? []).map(m => [m.id, m.text]));
    return (p?.runs ?? []).filter(r => r.status === 'queued')
      .map(r => ({ runId: r.id, messageId: r.userMessageId, text: text.get(r.userMessageId) ?? null, held: !!r.queueHeld }));
  },
  cancel: (cfg, threadId, runId) =>
    // A rejected command id stays rejected, so each attempt gets its own.
    rpc(cfg, 'orchestration.dispatchCommand', { type: 'queued-run.cancel', commandId: `coord:supersede:${runId}:${clock.now()}`, threadId, runId }),
};

// A queued run the pump created: its message id is the send commandId built from a `coord:` clientRequestId,
// and its text is a coord wake or reminder. Anything else (owner, agents, task notices) is never touched.
const ours = (thread, q) => !!q.messageId?.startsWith(`ardud-control:send:${thread}:coord%3A`) && /^\[coord[\] ]/.test(q.text ?? '');

// Cancels the pump's own queued runs in `items`; their unacked deliveries go back to pending so the next ring
// covers them. Returns the cancelled run ids.
async function supersede(cfg, queue, thread, items, reason, res) {
  const done = [];
  for (const q of items.filter(q => ours(thread, q))) {
    try {
      await queue.cancel(cfg, thread, q.runId);
      done.push(q.runId);
    } catch (err) {
      res.queueErrors.push({ thread, runId: q.runId, error: err.message });
    }
  }
  if (!done.length) return done;
  const requeued = tx(() => {
    let n = 0;
    const back = (where, ...a) => { n += Number(run(`UPDATE deliveries SET status='pending', next_attempt_at=NULL, thread_id=?, gen=gen+1
      WHERE status='sent' AND attempts<? AND recipient IN (SELECT id FROM actors WHERE kind='thread' AND thread_id=?) AND ${where}`,
    thread, MAX_ATTEMPTS, thread, ...a).changes); };
    for (const id of done) back('run_id=?', id);
    // A cancelled reminder (the thread's last ring) never got read either; its rows get a fresh wake.
    const w = get('SELECT * FROM wakes WHERE thread_id=?', thread);
    if (w?.kind === 'reminder' && done.includes(w.run_id)) for (const [seq, r] of JSON.parse(w.covered ?? '[]')) back('event_seq=? AND recipient=?', seq, r);
    return n;
  });
  res.superseded += done.length;
  res.supersedes.push({ thread, reason, runs: done.length, requeued });
  return done;
}
const plural = n => `${n} unacked ${n === 1 ? 'delivery' : 'deliveries'}`;

// One wake (or reminder) for every actor bound to the thread. Single-recipient control/blocker events are
// summarized inline; everything else is read through the inbox.
export function wakeText(rows, { remind = false } = {}) {
  const by = new Map();
  for (const d of rows) (by.get(d.recipient) ?? by.set(d.recipient, []).get(d.recipient)).push(d);
  const lines = [];
  for (const [actor, rs] of by) {
    const open = get("SELECT COUNT(*) n, MIN(event_seq) lo, MAX(event_seq) hi FROM deliveries WHERE recipient=? AND status!='acked'", actor);
    const n = Math.max(open.n, rs.length);
    const last = rs.at(-1);
    const seqs = open.n > 1 ? `seqs ${open.lo}-${open.hi}` : `seq ${last.event_seq}`;
    lines.push(`[coord${remind ? ' reminder' : ''}] ${plural(n)} for ${actor} (${seqs}, newest: #${last.event_seq} ${last.kind} from ${last.sender}: ${clip(last.summary, 200)}). ` +
      `Read \`coord inbox --as ${actor} --unacked\`, handle, ack.`);
    for (const d of rs) if (!remind && INLINE.has(d.kind) && d.fanout === 1) lines.push(`  ${d.kind} #${d.event_seq} from ${d.sender}: ${clip(d.summary, 300)}`);
  }
  return `${lines.join('\n')}\n\nThis is a coordination message, not owner approval.`;
}

// Attempts are part of the id so a re-ring of the same rows after a lost wake posts a new message instead of
// replaying the old one; a crash replay reuses the inflight id instead.
const wakeId = (thread, rows, remind) =>
  `coord:${remind ? 'remind' : 'wake'}:${createHash('sha256').update(JSON.stringify([thread, rows.map(d => d.client_request_id).sort(),
    ...(remind ? [] : [rows.reduce((n, d) => n + d.attempts, 0)])])).digest('hex')}`;

const paused = d => d.kind !== 'control' && gate(d.environment ? `env:${d.environment}` : undefined).mode === 'pause';
const ROW = `SELECT d.*, e.kind, e.environment, e.sender, e.summary, e.created_at,
  (SELECT COUNT(*) FROM deliveries x WHERE x.event_seq=d.event_seq) fanout FROM deliveries d JOIN events e ON e.seq=d.event_seq`;
const DUE = `${ROW} WHERE d.status='pending' AND d.thread_id IS NOT NULL AND COALESCE(d.next_attempt_at,0)<=?`;
// Sent, unacked, not yet reminded, past the threshold (`?` = now - unackedAfter), and not leased by another pump.
const REMIND = `${ROW} WHERE d.status='sent' AND d.reminded=0 AND d.sent_at<=? AND COALESCE(d.next_attempt_at,0)<=?`;

// Due rows in order, skipping held (paused) rows so they cannot starve deliverable ones.
function candidates(base, args) {
  const out = [];
  let held = 0, cur = [0, ''];
  for (;;) {
    const page = all(`${base} AND (d.event_seq>? OR (d.event_seq=? AND d.recipient>?)) ORDER BY d.event_seq, d.recipient LIMIT 200`,
      ...args(), cur[0], cur[0], cur[1]);
    for (const d of page) {
      if (paused(d)) held++;
      else if (out.length < MAX_ROWS) out.push(d);
    }
    if (page.length < 200) break;
    cur = [page.at(-1).event_seq, page.at(-1).recipient];
  }
  return { rows: out, held };
}

// Rows grouped by the recipient actor's current thread. Initial sends must still target the row's thread.
function byThread(rows, remind) {
  const m = new Map();
  for (const d of rows) {
    const a = get('SELECT * FROM actors WHERE id=?', d.recipient);
    if (a?.kind !== 'thread' || !a.thread_id || (!remind && a.thread_id !== d.thread_id)) continue;
    (m.get(a.thread_id) ?? m.set(a.thread_id, []).get(a.thread_id)).push(d);
  }
  return m;
}

// Reserves a thread's rows right before a ring: takes the thread lease (one ring in flight per thread),
// re-reads each row, its actor's thread and the pause, then bumps gen. Result writes must match that gen,
// so an ack, retarget or newer reservation wins. A ring of the same kind that never settled keeps its
// clientRequestId, so a retry after a crash replays it in Robob.
function reserve(thread, rows, { remind = false, unackedAfter, coalesce = false } = {}) {
  return tx(() => {
    const t = clock.now();
    const w = get('SELECT * FROM wakes WHERE thread_id=?', thread);
    if (w?.lease_until > t) return null;
    if (remind && w?.rung_at > t - unackedAfter) return null;
    const out = [];
    for (const c of rows) {
      const d = remind ? get(`${REMIND} AND d.event_seq=? AND d.recipient=?`, t - unackedAfter, t, c.event_seq, c.recipient)
        : get(`${DUE} AND d.event_seq=? AND d.recipient=?`, t, c.event_seq, c.recipient);
      if (!d || paused(d)) continue;
      const a = get('SELECT * FROM actors WHERE id=?', d.recipient);
      if (a?.kind !== 'thread' || a.thread_id !== thread || (!remind && d.thread_id !== thread)) continue;
      run(`UPDATE deliveries SET ${remind ? '' : 'attempts=attempts+1, '}next_attempt_at=?, gen=gen+1 WHERE event_seq=? AND recipient=?`, t + LEASE, d.event_seq, d.recipient);
      out.push({ ...d, gen: d.gen + 1, attempts: d.attempts + (remind ? 0 : 1) });
    }
    if (!out.length) return null;
    // An unsettled ring that already covered every reserved row is replayed under its id; anything new
    // gets a fresh ring.
    const prev = w?.inflight ? JSON.parse(w.inflight) : null;
    const keys = out.map(d => d.client_request_id);
    const reuse = prev && prev.id.startsWith(`coord:${remind ? 'remind' : 'wake'}:`) && keys.every(k => prev.rows.includes(k));
    const inflight = coalesce ? w?.inflight ?? null : JSON.stringify(reuse ? prev : { id: wakeId(thread, out, remind), rows: keys });
    run(`INSERT INTO wakes (thread_id, lease_until, inflight) VALUES (?,?,?)
      ON CONFLICT(thread_id) DO UPDATE SET lease_until=excluded.lease_until, inflight=excluded.inflight`, thread, t + LEASE, inflight);
    out.id = inflight && JSON.parse(inflight).id;
    return out;
  });
}

// Marks reserved rows sent (or reminded) by the ring `r`; `ring` also records it as the thread's last ring.
function settle(thread, rows, r, { remind = false, ring } = {}, res) {
  tx(() => {
    const t = clock.now();
    for (const d of rows) {
      const u = remind
        ? run("UPDATE deliveries SET reminded=1, next_attempt_at=NULL WHERE event_seq=? AND recipient=? AND status='sent' AND gen=?", d.event_seq, d.recipient, d.gen)
        : run(`UPDATE deliveries SET status='sent', sent_at=?, message_id=?, run_id=?, last_error=NULL, next_attempt_at=NULL
            WHERE event_seq=? AND recipient=? AND status='pending' AND gen=?`, t, r?.messageId ?? null, r?.runId ?? null, d.event_seq, d.recipient, d.gen);
      if (Number(u.changes)) (remind ? res.reminded : res.sent).push({ seq: d.event_seq, recipient: d.recipient, ...(remind ? {} : { messageId: r?.messageId ?? null, delivery: r?.delivery ?? null }) });
    }
    if (ring) run(`UPDATE wakes SET kind=?, client_request_id=?, covered=?, message_id=?, run_id=?, delivery=?, rung_at=?, lease_until=NULL, inflight=NULL WHERE thread_id=?`,
      ring.kind, ring.id, JSON.stringify(rows.map(d => [d.event_seq, d.recipient])), r?.messageId ?? null, r?.runId ?? null, r?.delivery ?? null, t, thread);
    else run('UPDATE wakes SET lease_until=NULL WHERE thread_id=?', thread);
  });
}

function fail(thread, rows, err, { remind = false } = {}, res) {
  tx(() => {
    let fatalAll = !remind;
    for (const d of rows) {
      if (remind) {
        run('UPDATE deliveries SET next_attempt_at=? WHERE event_seq=? AND recipient=? AND gen=?', clock.now() + 300, d.event_seq, d.recipient, d.gen);
        res.retry.push({ seq: d.event_seq, recipient: d.recipient, reminder: true, error: err.message });
        continue;
      }
      const fatal = err.status === 404 || err.status === 400 || d.attempts >= MAX_ATTEMPTS;
      fatalAll &&= fatal;
      const back = Math.min(3600, 30 * 2 ** (d.attempts - 1));
      run(`UPDATE deliveries SET status=?, last_error=?, next_attempt_at=? WHERE event_seq=? AND recipient=? AND status='pending' AND gen=?`,
        fatal ? 'failed' : 'pending', `${err.code ?? 'error'}: ${err.message}`.slice(0, 500), fatal ? null : clock.now() + back, d.event_seq, d.recipient, d.gen);
      (fatal ? res.failed : res.retry).push({ seq: d.event_seq, recipient: d.recipient, error: err.message });
    }
    run(`UPDATE wakes SET lease_until=NULL${fatalAll ? ', inflight=NULL' : ''} WHERE thread_id=?`, thread);
  });
}

async function ring(cfg, send, thread, rows, opts, res) {
  const kind = opts.remind ? 'reminder' : 'wake';
  const id = rows.id;
  try {
    const r = await send(cfg, thread, wakeText(rows, opts), id);
    settle(thread, rows, r, { ...opts, ring: { kind, id } }, res);
    res.wakes.push({ thread, kind, deliveries: rows.length, delivery: r?.delivery ?? null });
  } catch (err) {
    fail(thread, rows, err, opts, res);
  }
}

// `seq` limits the run to threads with that delivery pending (the post-time nudge); it sends no reminders.
// A wake whose turn failed, or was cancelled after it started (server restart), before its deliveries were
// acked was lost; its unacked rows go back to pending so the next ring covers them again instead of waiting
// for a reminder. A wake still queued behind a held queue is lost too: Robob will not start it on its own.
// Interrupts are the owner's call and a cancel before start is a promote-to-steer, so neither is re-rung.
// Rate-limited by HEAL.relostAfter since the last ring and MAX_ATTEMPTS per row, so a thread whose turns
// keep failing is not rung every tick.
function requeueLost(thread, info, held) {
  const w = get('SELECT * FROM wakes WHERE thread_id=?', thread);
  if (!w?.run_id || w.rung_at > clock.now() - HEAL.relostAfter) return 0;
  const r = (info?.recentRuns ?? []).find(x => x.runId === w.run_id);
  if (!r || !(r.status === 'failed' || (r.status === 'cancelled' && r.startedAt) || (held && UNREAD.has(r.status)))) return 0;
  return tx(() => Number(run(`UPDATE deliveries SET status='pending', next_attempt_at=NULL, thread_id=?, gen=gen+1
    WHERE run_id=? AND status='sent' AND attempts<? AND recipient IN (SELECT id FROM actors WHERE kind='thread' AND thread_id=?)`,
    thread, w.run_id, MAX_ATTEMPTS, thread).changes));
}

// Stale held queues, at most once per HEAL.sweepEvery: an actor thread held staleHeldAfter whose queue holds only
// coord wakes has them all cancelled, so the fresh wake rung this tick is the one that runs. A held queue with
// anything else is left alone and listed under `pump:held_queues` for `coord attention`.
export const SWEEP = 'pump:sweep';
export const HELD_QUEUES = 'pump:held_queues';
const stamp = (k, v) => run(`INSERT INTO control (k,v,set_by,set_at,reason) VALUES (?,?,'pump',?,NULL)
  ON CONFLICT(k) DO UPDATE SET v=excluded.v, set_by=excluded.set_by, set_at=excluded.set_at`, k, v, clock.now());
async function sweep(cfg, look, queue, res) {
  if (clock.now() - Number(get('SELECT v FROM control WHERE k=?', SWEEP)?.v ?? 0) < HEAL.sweepEvery) return;
  stamp(SWEEP, String(clock.now()));
  const heldQueues = [];
  const actors = all("SELECT id, thread_id FROM actors WHERE kind='thread' AND thread_id IS NOT NULL ORDER BY id");
  for (const thread of new Set(actors.map(a => a.thread_id))) {
    let info, items;
    try {
      info = await look(cfg, thread);
      if (!heldQueue(info, clock.now(), HEAL.staleHeldAfter)) continue;
      items = await queue.list(cfg, thread);
    } catch (err) {
      res.queueErrors.push({ thread, error: err.message });
      continue;
    }
    const other = items.filter(q => !ours(thread, q));
    if (!other.length) {
      await supersede(cfg, queue, thread, items, 'stale_held', res);
      continue;
    }
    const last = Math.max(0, ...(info.recentRuns ?? []).flatMap(r => [sec(r.requestedAt), sec(r.startedAt), sec(r.completedAt)]));
    heldQueues.push({ thread, actors: actors.filter(a => a.thread_id === thread).map(a => a.id), held_min: Math.floor((clock.now() - last) / 60),
      coord: items.length - other.length, other: other.map(q => ({ runId: q.runId, text: clip(q.text ?? '', 120) })) });
  }
  stamp(HELD_QUEUES, JSON.stringify(heldQueues));
}

// `seq` limits the run to threads with that delivery pending (the post-time nudge); it sends no reminders.
export async function deliver({ cfg, limit = 50, seq, send = sendToThread, look = threadDetail, queue = queueApi, unackedAfter = DEFAULTS.unackedAfter } = {}) {
  const res = { sent: [], failed: [], retry: [], reminded: [], wakes: [], held: 0, skipped: 0, healed: 0, heals: [], stuck: [],
    superseded: 0, supersedes: [], queueErrors: [] };
  // messaging=robob: Robob's doorbell wakes threads; coord rings nobody and leaves its own deliveries as they are.
  const m = messaging();
  if (m.mode === 'robob') return { ...res, messaging: { mode: m.mode, mission: m.mission } };
  cfg ??= controlConfig();
  const one = seq == null ? null : Number(seq);
  if (one == null) await sweep(cfg, look, queue, res);
  const pending = () => byThread(candidates(DUE, () => [clock.now()]).rows, false);
  const { rows, held } = candidates(DUE, () => [clock.now()]);
  res.held = held;
  const due = byThread(rows, false);
  if (one != null) for (const [t, rs] of due) if (!rs.some(d => d.event_seq === one)) due.delete(t);
  const stale = one == null ? byThread(candidates(REMIND, () => [clock.now() - unackedAfter, clock.now()]).rows, true) : new Map();
  // Threads whose last wake was lost, even with nothing new due.
  const lost = one == null ? all(`SELECT DISTINCT w.thread_id FROM wakes w JOIN deliveries d ON d.run_id=w.run_id AND d.status='sent'
    WHERE w.rung_at<=?`, clock.now() - HEAL.relostAfter).map(x => x.thread_id) : [];
  for (const thread of [...new Set([...due.keys(), ...stale.keys(), ...lost])].slice(0, limit)) {
    let pend = due.get(thread) ?? [];
    let info;
    try {
      info = await look(cfg, thread);
    } catch (err) {
      const r = pend.length ? reserve(thread, pend) : null;
      if (r) fail(thread, r, err, {}, res); else res.skipped++;
      continue;
    }
    const t = clock.now();
    const why = [];
    const held = heldQueue(info, t);
    if (one == null && requeueLost(thread, info, held)) {
      why.push('lost_wake');
      pend = pending().get(thread) ?? [];
    }
    const w = get('SELECT * FROM wakes WHERE thread_id=?', thread);
    if (!held && w?.run_id && (info?.recentRuns ?? []).some(x => x.runId === w.run_id && UNREAD.has(x.status))) {
      // The last wake is still queued unread; it will show these too.
      const r = pend.length ? reserve(thread, pend, { coalesce: true }) : null;
      if (r) settle(thread, r, { messageId: w.message_id, runId: w.run_id, delivery: 'coalesced' }, {}, res); else res.skipped++;
      continue;
    }
    const overdue = pend.some(d => d.created_at <= t - unackedAfter) || stale.has(thread);
    // A held queue rings like an idle thread (a queue-mode send to a thread with nothing running starts at
    // once); a long turn gets a queued wake so it is read when the turn ends.
    if (held) why.push('held_queue');
    else if (!RINGABLE.has(info?.state) && overdue && longRun(info, t)) why.push('long_run');
    if (!RINGABLE.has(info?.state) && !held && !why.includes('long_run')) {
      if (overdue) {
        const oldest = Math.min(...pend.map(d => d.created_at), ...(stale.get(thread) ?? []).map(d => d.sent_at));
        res.stuck.push({ thread, state: info?.state ?? null, oldest_min: Math.floor((t - oldest) / 60) });
      }
      res.skipped++;
      continue;
    }
    // About to queue a wake on a thread that may hold queued runs (an idle thread holds none): the pump's own
    // earlier wakes are cancelled first, so only the newest one is left to run.
    if (info?.state !== 'idle' && (pend.length || stale.has(thread))) {
      let items = [];
      try { items = await queue.list(cfg, thread); } catch (err) { res.queueErrors.push({ thread, error: err.message }); }
      if ((await supersede(cfg, queue, thread, items, 'ring', res)).length) pend = pending().get(thread) ?? [];
    }
    const before = res.wakes.length;
    const r = pend.length ? reserve(thread, pend) : null;
    if (r) await ring(cfg, send, thread, r, {}, res);
    else {
      const s = stale.has(thread) ? reserve(thread, stale.get(thread), { remind: true, unackedAfter }) : null;
      if (s) await ring(cfg, send, thread, s, { remind: true }, res); else res.skipped++;
    }
    if (why.length && res.wakes.length > before) { res.healed++; res.heals.push({ thread, reason: why.join('+') }); }
  }
  return res;
}

// Heartbeat: every tick stamps `pump:heartbeat` in control, so `coord status`/`attention` show a dead pump.
export const HEARTBEAT = 'pump:heartbeat';
function heartbeat(res) {
  const t = clock.now();
  const prev = get('SELECT set_at FROM control WHERE k=?', HEARTBEAT)?.set_at ?? null;
  const v = JSON.stringify({ sent: res?.sent?.length ?? 0, healed: res?.healed ?? 0, stuck: res?.stuck?.length ?? 0,
    superseded: res?.superseded ?? 0, error: res?.error ?? null });
  stamp(HEARTBEAT, v);
  return { at: new Date(t * 1000).toISOString(), gap_s: prev == null ? null : t - prev, superseded: res?.superseded ?? 0 };
}

// launchd appends every tick to one log and never rotates it (13 MB by Oct 2026). The LaunchAgent sets
// COORD_PUMP_LOG to its StandardOutPath; a tick that finds that file over `max` renames it to `<log>.1`.
// launchd opens the path again for every run, so this tick still writes into `.1` and the next starts a new file.
export function rotateLog(path = process.env.COORD_PUMP_LOG, max = 10 * 1024 * 1024) {
  if (!path) return null;
  try {
    if (statSync(path).size <= max) return null;
    renameSync(path, `${path}.1`);
    return { rotated: `${path}.1` };
  } catch (e) {
    return e.code === 'ENOENT' ? null : { error: e.message };
  }
}

// One pump tick: deliveries, then observe a bounded number of running releases (oldest observation first).
export async function pump({ cfg, observe, observeLimit = 5, ...o } = {}) {
  const out = { deliver: await deliver({ cfg, ...o }).catch(e => ({ error: e.message })), observed: [] };
  out.heartbeat = heartbeat(out.deliver);
  const rows = all(`SELECT id FROM releases WHERE state='running' AND kind IN ('service_release','frontend_release','redispatch')
    ORDER BY COALESCE(observed_at,0), id LIMIT ?`, observeLimit);
  for (const { id } of rows) {
    try {
      const r = await releaseObserve(id, observe ? { observe } : {});
      out.observed.push({ id, state: r.release.state, ...(r.pending ? { pending: r.pending } : {}) });
    } catch (e) {
      // releaseObserve records observation failures itself; what reaches here is a refusal, not evidence.
      out.observed.push({ id, error: e.code ?? 'error', message: e.message });
    }
  }
  return out;
}

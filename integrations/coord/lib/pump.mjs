// Delivery pump: pushes pending deliveries to Robob threads through the control API.
// At-least-once: the clientRequestId is deterministic per (event, recipient), so a resend after a
// crash between send and mark replays the first result in Robob instead of posting twice.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tx, get, all, run } from './db.mjs';
import { clock, gate, DEFAULTS, releaseObserve } from './coord.mjs';

const PREFIX = '/api/ardud/control';
const MAX_ATTEMPTS = 8;
const LEASE = 120;

export function controlConfig(o = {}) {
  let url = o.url ?? process.env.T3_CONTROL_URL;
  let token = o.token ?? process.env.T3_CONTROL_TOKEN;
  if (!url || !token) {
    const file = process.env.T3_CONTROL_TOKEN_FILE ?? join(homedir(), '.robob', 'ardud-control.json');
    try {
      if (statSync(file).mode & 0o077) throw new Error(`${file} must be chmod 600`);
      const s = JSON.parse(readFileSync(file, 'utf8'));
      url ??= s.url;
      token ??= s.token;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  if (!url || !token) throw new Error('no control API url/token');
  return { url: url.replace(/\/+$/, ''), token };
}

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
export const threadState = async (cfg, threadId) => (await call(cfg, 'GET', `/threads/${encodeURIComponent(threadId)}`)).thread?.state;

export function render(e, recipient) {
  const meta = [['kind', e.kind], ['work', e.work_id], ['env', e.environment], ['rev', e.expected_revision], ['authority', e.authority_ref], ['reply-to', e.reply_to]]
    .filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}: ${v}`).join(' | ');
  const body = e.body_json ? `\n\n${e.body_json.length > 6000 ? `${e.body_json.slice(0, 6000)}… (coord inbox --as ${recipient} --after ${e.seq - 1})` : e.body_json}` : '';
  return `[coord ${e.channel_id} #${e.seq} from ${e.sender}] ${e.summary}\n${meta}${body}\n\nThis is a coordination message, not owner approval. ` +
    `When read, ack it: coord ack --as ${recipient} ${e.seq}`;
}

const paused = d => d.kind !== 'control' && gate(d.environment ? `env:${d.environment}` : undefined).mode === 'pause';
const DUE = `SELECT d.*, e.kind, e.environment FROM deliveries d JOIN events e ON e.seq=d.event_seq
  WHERE d.status='pending' AND d.thread_id IS NOT NULL AND COALESCE(d.next_attempt_at,0)<=?`;
// Sent, unacked, not yet reminded, past the threshold (`?` = now - unackedAfter), and not leased by another pump.
const REMIND = `SELECT d.*, e.kind, e.environment FROM deliveries d JOIN events e ON e.seq=d.event_seq
  WHERE d.status='sent' AND d.reminded=0 AND d.sent_at<=? AND COALESCE(d.next_attempt_at,0)<=?`;

// Reserves one row right before its send: re-reads it, its actor's current thread and the effective pause,
// then bumps gen. The result write must match that gen, so an ack, retarget or newer reservation wins.
// Initial sends must still target the row's thread; reminders go to the actor's current thread.
function reserve(seq, recipient, { remind = false, unackedAfter } = {}) {
  return tx(() => {
    const t = clock.now();
    const d = remind ? get(`${REMIND} AND d.event_seq=? AND d.recipient=?`, t - unackedAfter, t, seq, recipient)
      : get(`${DUE} AND d.event_seq=? AND d.recipient=?`, t, seq, recipient);
    if (!d || paused(d)) return null;
    const a = get('SELECT * FROM actors WHERE id=?', d.recipient);
    if (a?.kind !== 'thread' || !a.thread_id || (!remind && a.thread_id !== d.thread_id)) return null;
    run(`UPDATE deliveries SET ${remind ? '' : 'attempts=attempts+1, '}next_attempt_at=?, gen=gen+1 WHERE event_seq=? AND recipient=?`, t + LEASE, seq, recipient);
    return { ...get(`SELECT d.*, e.kind, e.environment FROM deliveries d JOIN events e ON e.seq=d.event_seq WHERE d.event_seq=? AND d.recipient=?`, seq, recipient), target: a.thread_id };
  });
}

// Due rows in order, skipping held (paused) rows so they cannot starve deliverable ones.
function candidates(limit, seq, { base = DUE, args = () => [clock.now()] } = {}) {
  const out = [];
  let held = 0, cur = [0, ''];
  for (;;) {
    const page = all(`${base} AND (d.event_seq>? OR (d.event_seq=? AND d.recipient>?)) AND (? IS NULL OR d.event_seq=?)
      ORDER BY d.event_seq, d.recipient LIMIT 200`, ...args(), cur[0], cur[0], cur[1], seq, seq);
    for (const d of page) {
      if (paused(d)) held++;
      else if (out.length < limit) out.push(d);
    }
    if (page.length < 200) break;
    cur = [page.at(-1).event_seq, page.at(-1).recipient];
  }
  return { rows: out, held };
}

export async function deliver({ cfg, limit = 50, seq, send = sendToThread, unackedAfter = DEFAULTS.unackedAfter } = {}) {
  const res = { sent: [], failed: [], retry: [], reminded: [], held: 0, skipped: 0 };
  cfg ??= controlConfig();
  const { rows, held } = candidates(limit, seq == null ? null : Number(seq));
  res.held = held;
  for (const c of rows) {
    const d = reserve(c.event_seq, c.recipient);
    if (!d) { res.skipped++; continue; }
    const e = get('SELECT * FROM events WHERE seq=?', d.event_seq);
    try {
      const r = await send(cfg, d.thread_id, render(e, d.recipient), d.client_request_id);
      const u = run(`UPDATE deliveries SET status='sent', sent_at=?, message_id=?, run_id=?, last_error=NULL, next_attempt_at=NULL
        WHERE event_seq=? AND recipient=? AND status='pending' AND gen=?`, clock.now(), r?.messageId ?? null, r?.runId ?? null, d.event_seq, d.recipient, d.gen);
      if (Number(u.changes)) res.sent.push({ seq: d.event_seq, recipient: d.recipient, messageId: r?.messageId ?? null, delivery: r?.delivery ?? null });
    } catch (err) {
      const fatal = err.status === 404 || err.status === 400 || d.attempts >= MAX_ATTEMPTS;
      const back = Math.min(3600, 30 * 2 ** (d.attempts - 1));
      run(`UPDATE deliveries SET status=?, last_error=?, next_attempt_at=? WHERE event_seq=? AND recipient=? AND status='pending' AND gen=?`,
        fatal ? 'failed' : 'pending', `${err.code ?? 'error'}: ${err.message}`.slice(0, 500), fatal ? null : clock.now() + back, d.event_seq, d.recipient, d.gen);
      (fatal ? res.failed : res.retry).push({ seq: d.event_seq, recipient: d.recipient, error: err.message });
    }
  }
  if (!seq) {
    // One reminder for a delivery left unacked; after that it only shows in `coord attention`.
    // Same discipline as initial sends: eligible rows before the limit, fresh re-read and gen per send.
    const { rows: due } = candidates(limit, null, { base: REMIND, args: () => [clock.now() - unackedAfter, clock.now()] });
    for (const c of due) {
      const d = reserve(c.event_seq, c.recipient, { remind: true, unackedAfter });
      if (!d) { res.skipped++; continue; }
      try {
        await send(cfg, d.target, `[coord reminder #${d.event_seq}] still unacked. Read it with coord inbox --as ${d.recipient} --unacked, then: coord ack --as ${d.recipient} ${d.event_seq}`,
          `${d.client_request_id}:remind`);
        const u = run("UPDATE deliveries SET reminded=1, next_attempt_at=NULL WHERE event_seq=? AND recipient=? AND status='sent' AND gen=?", d.event_seq, d.recipient, d.gen);
        if (Number(u.changes)) res.reminded.push({ seq: d.event_seq, recipient: d.recipient });
      } catch (err) {
        run("UPDATE deliveries SET next_attempt_at=? WHERE event_seq=? AND recipient=? AND gen=?", clock.now() + 300, d.event_seq, d.recipient, d.gen);
        res.retry.push({ seq: d.event_seq, recipient: d.recipient, reminder: true, error: err.message });
      }
    }
  }
  return res;
}

// One pump tick: deliveries, then observe a bounded number of running releases (oldest observation first).
export async function pump({ cfg, observe, observeLimit = 5, ...o } = {}) {
  const out = { deliver: await deliver({ cfg, ...o }).catch(e => ({ error: e.message })), observed: [] };
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

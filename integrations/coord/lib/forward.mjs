// Messaging forward mode (control row `messaging=robob`). post, inbox and ack go to the coord shim of the Robob
// missions API instead of coord.db. Requests and replies keep coord's shapes and refusal codes, so the CLI, crw and
// scripts see no difference. Claims, QA windows, releases and the arch queue never come here.
//
//   POST /api/ardud/missions/coord/post   {mission, channel, as, kind, key, hash, summary, to, work, env, rev, authority, body, replyTo}
//        -> {ok, seq, recipients} | {ok, seq, duplicate: true}
//   GET  /api/ardud/missions/coord/inbox?mission&as&unacked&after&limit   -> {ok, events: [coord event rows]}
//   POST /api/ardud/missions/coord/ack    {mission, as, refs: [seq | key]} -> {ok, acked: [{seq} | {seq, already: true}]}
//
// `hash` is coord's canonical content hash; the same key with a different hash is a conflict (409, with the first seq).
// Failures arrive as {ok: false, error: {code, message, ...extra}} and are rethrown as CoordError. A network failure,
// timeout or a reply without a refusal is `messaging_unavailable`: nothing is written to coord.db as a fallback, and
// a caller may retry a post under the same key.
import { CoordError } from './db.mjs';
import { controlConfig } from './control.mjs';

export const SHIM = '/api/ardud/missions/coord';
const TIMEOUT_MS = 30_000;

let target = null;
// Override the Robob location (tests, embedding processes). null goes back to controlConfig().
export function messagingTarget(cfg) {
  target = cfg ? { url: String(cfg.url).replace(/\/+$/, ''), token: cfg.token } : null;
}

async function call(method, path, body) {
  let cfg;
  try { cfg = target ?? controlConfig(); } catch (e) { throw new CoordError('messaging_unavailable', `messaging=robob: ${e.message}`); }
  let res;
  try {
    res = await fetch(`${cfg.url}${SHIM}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new CoordError('messaging_unavailable', `Robob missions API unreachable: ${e.message}`);
  }
  const data = await res.json().catch(() => null);
  if (data?.ok === false && data.error?.code) {
    const { code, message, ...extra } = data.error;
    throw new CoordError(code, message ?? code, extra);
  }
  if (!res.ok || !data || data.ok !== true) throw new CoordError('messaging_unavailable', `Robob missions API answered HTTP ${res.status}`, { status: res.status });
  const { ok: _ok, ...rest } = data;
  return rest;
}

export const post = payload => call('POST', '/post', payload);

export function inbox({ mission, as, unacked, after, limit }) {
  const q = new URLSearchParams({ mission, as, unacked: unacked ? '1' : '0', after: String(after), limit: String(limit) });
  return call('GET', `/inbox?${q}`);
}

export const ack = ({ mission, as, refs }) => call('POST', '/ack', { mission, as, refs });

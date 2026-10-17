// Stand-in for the coord shim of the Robob missions API (lib/forward.mjs has the contract). It keeps coord's
// semantics in memory: one room per channel, room members from coord's members table, mission-wide seqs, read
// positions per recipient. Seeded from the coord DB's actors/channels/members, as the import would.
import { createServer } from 'node:http';
import * as C from '../lib/coord.mjs';
import { all } from '../lib/db.mjs';

export async function fakeMissions({ mission = 'crpko', token = 'test-token' } = {}) {
  const actors = new Map(all('SELECT * FROM actors').map(a => [a.id, a]));
  const channels = new Map(all('SELECT * FROM channels').map(c => [c.id, c]));
  const members = all('SELECT * FROM members ORDER BY channel_id, actor_id');
  const messages = [];
  const byKey = new Map();
  const deliveries = new Map(); // `${seq}|${recipient}` -> {status, acked_at}
  const requests = [];
  let seq = 0;
  let down = false;
  const refuse = (code, message, extra = {}, status = 400) => ({ status, body: { ok: false, error: { code, message, ...extra } } });

  function post(b) {
    const prev = byKey.get(b.key);
    if (prev) {
      if (prev.hash !== b.hash) return refuse('conflict', `event ${b.key} exists with a different body`, { status: 409, seq: prev.seq }, 409);
      return { body: { ok: true, seq: prev.seq, duplicate: true } };
    }
    const c = channels.get(b.channel);
    if (!c) return refuse('not_found', `no channel ${b.channel}`, {}, 404);
    if (c.status !== 'open') return refuse('channel_archived', `channel ${b.channel} is archived`);
    const room = members.filter(m => m.channel_id === b.channel);
    const recips = (b.to ?? room.map(m => m.actor_id)).filter(r => r !== b.as);
    for (const r of recips) if (!actors.has(r)) return refuse('unknown_actor', `no actor ${r}`);
    const m = { seq: ++seq, event_key: b.key, body_hash: b.hash, channel_id: b.channel, kind: b.kind, sender: b.as, work_id: b.work,
      environment: b.env, expected_revision: b.rev, authority_ref: b.authority, summary: b.summary, body_json: b.body,
      reply_to: b.replyTo, created_at: C.clock.now() };
    messages.push(m);
    byKey.set(b.key, { seq: m.seq, hash: b.hash });
    for (const r of new Set(recips)) {
      const a = actors.get(r);
      const push = a.kind === 'thread' && a.thread_id && (b.to || room.find(x => x.actor_id === r)?.wake);
      deliveries.set(`${m.seq}|${r}`, { status: push ? 'pending' : 'skipped', acked_at: null });
    }
    return { body: { ok: true, seq: m.seq, recipients: recips } };
  }

  function inbox(q) {
    const as = q.get('as');
    const after = Number(q.get('after')) || 0;
    const rows = messages.filter(m => m.seq > after && deliveries.has(`${m.seq}|${as}`))
      .map(m => ({ ...m, delivery: deliveries.get(`${m.seq}|${as}`).status, acked_at: deliveries.get(`${m.seq}|${as}`).acked_at }))
      .filter(r => q.get('unacked') !== '1' || r.delivery !== 'acked')
      .slice(0, Number(q.get('limit')));
    return { body: { ok: true, events: rows } };
  }

  function ack(b) {
    const out = [];
    for (const ref of b.refs) {
      const m = /^\d+$/.test(ref) ? messages.find(x => x.seq === Number(ref)) : messages.find(x => x.event_key === ref);
      if (!m) return refuse('not_found', `no event ${ref}`, {}, 404);
      const d = deliveries.get(`${m.seq}|${b.as}`);
      if (!d) return refuse('not_addressed', `event ${ref} was not addressed to ${b.as}`);
      out.push(d.status === 'acked' ? { seq: m.seq, already: true } : { seq: m.seq });
    }
    // All-or-nothing like coord's transaction: mark only after every ref resolved.
    for (const r of out) if (!r.already) Object.assign(deliveries.get(`${r.seq}|${b.as}`), { status: 'acked', acked_at: C.clock.now() });
    return { body: { ok: true, acked: out } };
  }

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      const send = ({ status = 200, body }) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (down) return send({ status: 503, body: { message: 'down' } });
      if (req.headers.authorization !== `Bearer ${token}`) return send(refuse('unauthorized', 'bad token', {}, 401));
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      const m = /^\/api\/ardud\/missions\/coord\/(post|inbox|ack)$/.exec(url.pathname);
      if (!m) return send(refuse('not_found', url.pathname, {}, 404));
      const forMission = m[1] === 'inbox' ? url.searchParams.get('mission') : body?.mission;
      if (forMission !== mission) return send(refuse('not_found', `no mission ${forMission}`, {}, 404));
      if (m[1] === 'post') return send(post(body));
      if (m[1] === 'inbox') return send(inbox(url.searchParams));
      return send(ack(body));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const cfg = { url: `http://127.0.0.1:${server.address().port}`, token };
  return { cfg, mission, messages, deliveries, requests, setDown: v => { down = v; }, close: () => new Promise(r => server.close(r)) };
}

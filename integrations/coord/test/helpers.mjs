import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as C from '../lib/coord.mjs';

export const tmp = () => mkdtempSync(join(tmpdir(), 'coord-test-'));

let t0 = 1_800_000_000;
export function fresh() {
  const dir = tmp();
  C.open(join(dir, 'coord.db'));
  t0 = 1_800_000_000;
  C.clock.now = () => t0;
  return join(dir, 'coord.db');
}
export const advance = s => { t0 += s; };

// Stand-in for the Robob control API. Like Robob, a repeated clientRequestId replays the first result.
export async function stubControl({ states = {} } = {}) {
  const sends = [];
  const byRequest = new Map();
  const messages = {};
  let failNext = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== 'Bearer test-token') return reply(401, { ok: false, error: { code: 'unauthorized', message: 'no' } });
      const m = /^\/api\/ardud\/control\/threads\/([^/]+)(\/send)?$/.exec(req.url);
      if (!m) return reply(404, { ok: false, error: { code: 'not_found', message: req.url } });
      const thread = decodeURIComponent(m[1]);
      if (!(thread in states)) return reply(404, { ok: false, error: { code: 'not_found', message: `no thread ${thread}` } });
      if (!m[2]) return reply(200, { ok: true, thread: { threadId: thread, state: states[thread] } });
      const body = JSON.parse(raw);
      sends.push({ thread, ...body });
      if (failNext > 0) { failNext--; return reply(503, { ok: false, error: { code: 'unavailable', message: 'down' } }); }
      const id = `ardud-control:send:${thread}:${encodeURIComponent(body.clientRequestId)}`;
      if (!byRequest.has(id)) {
        const delivery = states[thread] === 'running' && body.mode === 'queue' ? 'queued' : 'started';
        byRequest.set(id, { messageId: id, runId: `run-${byRequest.size + 1}`, delivery });
        (messages[thread] ??= []).push({ messageId: id, text: body.text });
      }
      reply(200, { ok: true, threadId: thread, ...byRequest.get(id) });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const cfg = { url: `http://127.0.0.1:${server.address().port}`, token: 'test-token' };
  return { cfg, sends, messages, states, failNext: n => { failNext = n; }, close: () => new Promise(r => server.close(r)) };
}

export const SHA1 = 'a'.repeat(40);
export const SHA2 = 'b'.repeat(40);
export const DIGEST = `sha256:${'c'.repeat(64)}`;

// OpenAI-compatible HTTP front on 127.0.0.1. Each request is cap-checked,
// SIWX-signed and forwarded to Venice; a 402 for low credit triggers one capped
// x402 top-up and one retry. Logs amounts and token counts, never content.
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { CapError, actualCost, estimateAndClamp } from './caps.mjs';
import { FALLBACK_MODELS } from './config.mjs';

const MAX_BODY = 32 * 1024 * 1024;

export function createProxy({ cfg, venice, ledger, clientToken, log = () => {}, egressCheck = defaultEgressCheck(cfg) }) {
  const prices = structuredClone(FALLBACK_MODELS);
  let active = 0;
  const waiters = [];
  const acquire = () => (active < cfg.maxConcurrent ? (active++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
  const releaseSlot = () => {
    const next = waiters.shift();
    if (next) next();
    else active--;
  };

  // Live prices only ever raise our estimate.
  async function refreshPrices() {
    try {
      const list = await venice.publicModels();
      for (const m of list) {
        const p = prices[m.id];
        const lp = m.model_spec?.pricing;
        if (!p || !lp) continue;
        const inp = Number(lp.input?.usd) / 1e6;
        const out = Number(lp.output?.usd) / 1e6;
        if (inp > p.input) p.input = inp;
        if (out > p.output) p.output = out;
        const ctx = Number(m.model_spec?.availableContextTokens);
        if (ctx > 0) p.context = ctx;
      }
      log({ event: 'prices', models: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, { inPerM: v.input * 1e6, outPerM: v.output * 1e6 }])) });
    } catch (e) {
      log({ event: 'prices_failed', error: String(e.message).slice(0, 200) });
    }
  }

  const send = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(obj));
  };
  const err = (res, status, code, message) => send(res, status, { error: { type: 'venice_x402', code, message } });

  const authorized = (req) => {
    const h = String(req.headers.authorization || '');
    const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
    const want = Buffer.from(clientToken);
    return got.length === want.length && timingSafeEqual(got, want);
  };

  async function readBody(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > MAX_BODY) throw new CapError('too_large', 'request body too large');
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async function forward(body) {
    return venice.authed('/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: body.stream ? 'text/event-stream' : 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function chat(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return err(res, 400, e.code || 'bad_request', e.message);
    }
    const price = prices[body.model];
    if (!price) return err(res, 400, 'model_not_allowed', `model ${body.model} is not enabled on this proxy (${cfg.models.join(', ')})`);
    if (!(await egressCheck())) return err(res, 503, 'egress_unverified', 'Venice egress via Mullvad could not be verified; request not sent');

    let est;
    let slot;
    try {
      est = estimateAndClamp(body, price, cfg.maxRequestUsd);
      slot = ledger.reserve(est.estUsd);
    } catch (e) {
      if (e instanceof CapError) {
        ledger.record({ kind: 'reject', code: e.code, model: body.model });
        log({ event: 'reject', code: e.code, message: e.message });
        return err(res, 429, e.code, e.message);
      }
      throw e;
    }
    // Strip reasoning-effort knobs the model does not accept (OpenCode sends its variant).
    if (price.reasoningEffort === false) {
      delete body.reasoning_effort;
      delete body.reasoning;
    }
    if (body.stream) body.stream_options = { ...(body.stream_options || {}), include_usage: true };

    await acquire();
    const started = Date.now();
    let usage = null;
    let status = 0;
    let requestId = null;
    try {
      let up = await forward(body);
      if (up.status === 402 && cfg.autoTopUp) {
        const info = await up.json().catch(() => ({}));
        if (info.reason === 'insufficient_balance' || info.code === 'PAYMENT_REQUIRED') {
          try {
            await venice.topUp('insufficient_balance');
          } catch (e) {
            log({ event: 'topup_failed', error: String(e.message).slice(0, 300) });
            return err(res, 402, e.code || 'topup_failed', `Venice credit is low and top-up failed: ${e.message}`);
          }
          up = await forward(body);
        } else {
          return err(res, 402, 'payment_required', String(info.error || 'Venice returned 402').slice(0, 300));
        }
      }
      status = up.status;
      if (!up.ok) {
        const text = await up.text();
        log({ event: 'upstream_error', status, body: text.slice(0, 300) });
        res.writeHead(status, { 'content-type': up.headers.get('content-type') || 'application/json' });
        return res.end(text);
      }
      if (!body.stream) {
        const json = await up.json();
        usage = json.usage;
        requestId = json.id;
        return send(res, 200, json);
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of up.body) {
        res.write(chunk);
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            if (j.usage) usage = j.usage;
            if (j.id) requestId = j.id;
          } catch {}
        }
      }
      res.end();
    } catch (e) {
      log({ event: 'proxy_error', error: String(e.message).slice(0, 300) });
      if (!res.headersSent) err(res, 502, 'upstream_failed', e.message);
      else res.end();
    } finally {
      releaseSlot();
      ledger.release(slot);
      if (status === 200 || usage) {
        const c = actualCost(usage, price);
        const entry = ledger.record({
          kind: 'charge',
          model: body.model,
          requestId,
          stream: !!body.stream,
          estUsd: est.estUsd,
          maxOutTokens: est.outTokens,
          clamped: est.clamped,
          // No usage reported (stream cut): book the worst case.
          ...(c ?? { costUsd: est.estUsd, usageMissing: true }),
          ms: Date.now() - started,
        });
        log({ event: 'charge', model: body.model, costUsd: entry.costUsd, estUsd: est.estUsd, promptTokens: entry.promptTokens, completionTokens: entry.completionTokens, day: ledger.snapshot() });
      }
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://x').pathname.replace(/^\/v1/, '');
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, address: venice.account.address, day: ledger.snapshot() });
      if (!authorized(req)) return err(res, 401, 'unauthorized', 'missing or wrong bearer token');
      if (req.method === 'GET' && path === '/models') {
        return send(res, 200, {
          object: 'list',
          data: cfg.models.map((id) => ({ id, object: 'model', owned_by: 'venice', context_length: prices[id].context })),
        });
      }
      if (req.method === 'POST' && path === '/chat/completions') return await chat(req, res);
      return err(res, 404, 'not_found', `${req.method} ${path} is not served by venice-x402`);
    } catch (e) {
      log({ event: 'handler_error', error: String(e.message).slice(0, 300) });
      if (!res.headersSent) err(res, 500, 'internal', 'internal error');
    }
  });
  return { server, refreshPrices, prices };
}

// Async (no event-loop stall for streams in flight); concurrent callers share one run.
export function defaultEgressCheck(cfg) {
  let okUntil = 0;
  let running = null;
  const run = () =>
    new Promise((resolve) => {
      const p = spawn('/bin/zsh', ['-c', cfg.egressCheck], { stdio: 'ignore' });
      const t = setTimeout(() => p.kill('SIGKILL'), 30_000);
      p.on('error', () => (clearTimeout(t), resolve(false)));
      p.on('exit', (code) => (clearTimeout(t), resolve(code === 0)));
    });
  return async () => {
    if (!cfg.egressCheck) return true;
    if (Date.now() < okUntil) return true;
    running ??= run().finally(() => (running = null));
    const ok = await running;
    if (ok) okUntil = Date.now() + cfg.egressCheckTtlMs;
    return ok;
  };
}
